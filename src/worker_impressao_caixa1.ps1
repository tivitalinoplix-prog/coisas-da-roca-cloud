<#
.SYNOPSIS
    Worker Invisível de Impressão Térmica Nativo em PowerShell para Caixa 1 (Coisas da Roça)
    100% Nativo (Zero dependência de Node.js).
    Comunicação HTTP via REST API com o Servidor Central (192.168.1.29:3001).
    Dispara na Bematech MP-100S TH / Elgin i8 via Win32 RAW Spooler (winspool.drv).
    Possui a Tríplice Trava de Concorrência do SASIII:
      1. Título de janela do processo DAM/SASIII (Blocklist de termos de venda ativa)
      2. I/O recente no banco local pdv.fdb (< 12 segundos)
      3. Fila do Spooler do Windows (Get-PrintJob)
      4. Cooldown de segurança de 10 segundos pós-fechamento do cupom
#>

[CmdletBinding()]
param(
    [string]$ServerUrl = "https://coisasdaroca-core-production.up.railway.app",
    [string]$ApiKey = "coisasdaroca_internal_caixa1_secret_2026",
    [string]$PrinterName = "MP-100S TH",
    [int]$CooldownSegundos = 10,
    [int]$IntervaloChecagemMs = 3000
)

# -----------------------------------------------------------------------------
# 0. SISTEMA DE LOG LOCAL (C:\CoisasDaRoca\worker.log)
# -----------------------------------------------------------------------------
$PastaApp = "C:\CoisasDaRoca"
$ArquivoLog = "$PastaApp\worker.log"

if (!(Test-Path $PastaApp)) {
    New-Item -ItemType Directory -Path $PastaApp -Force | Out-Null
}

function Escrever-Log {
    param([string]$Mensagem, [string]$Nivel = "INFO")
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $linha = "[$timestamp] [$Nivel] $Mensagem"
    Write-Host $linha
    try {
        Add-Content -Path $ArquivoLog -Value $linha -Encoding UTF8
    } catch {}
}

function Detectar-ImpressoraTermica {
    $printers = Get-Printer -ErrorAction SilentlyContinue
    if (Get-Printer -Name "MP-100S TH" -ErrorAction SilentlyContinue) {
        return "MP-100S TH"
    }
    $termica = $printers | Where-Object { $_.Name -match "(?i)MP-100|MP-4200|Bematech|Elgin|i8|i9|POS|Termica|Cupom|NFCe" } | Select-Object -First 1
    if ($termica) { return $termica.Name }
    $default = $printers | Where-Object { $_.Default -eq $true } | Select-Object -First 1
    if ($default) { return $default.Name }
    return "MP-100S TH"
}

$PrinterName = Detectar-ImpressoraTermica

Escrever-Log "=========================================================="
Escrever-Log "Iniciando Worker de Impressão Caixa 1 (Coisas da Roça)"
Escrever-Log "Servidor Central: $ServerUrl | Impressora Detectada: '$PrinterName'"
Escrever-Log "Cooldown: ${CooldownSegundos}s | Polling: ${IntervaloChecagemMs}ms"

# -----------------------------------------------------------------------------
# 1. COMPILAÇÃO DO RAW PRINTER HELPER (Win32 winspool.Drv)
# -----------------------------------------------------------------------------
$rawPrinterHelperCode = @"
using System;
using System.IO;
using System.Runtime.InteropServices;

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

    public static bool SendBytesToPrinter(string szPrinterName, byte[] bytes, string docName)
    {
        IntPtr pUnmanagedBytes = IntPtr.Zero;
        IntPtr hPrinter = IntPtr.Zero;
        DOCINFOA di = new DOCINFOA();
        bool bSuccess = false;

        di.pDocName = docName;
        di.pDataType = "RAW";

        if (OpenPrinter(szPrinterName.Normalize(), out hPrinter, IntPtr.Zero))
        {
            if (StartDocPrinter(hPrinter, 1, di))
            {
                if (StartPagePrinter(hPrinter))
                {
                    pUnmanagedBytes = Marshal.AllocCoTaskMem(bytes.Length);
                    Marshal.Copy(bytes, 0, pUnmanagedBytes, bytes.Length);

                    int dwWritten = 0;
                    bSuccess = WritePrinter(hPrinter, pUnmanagedBytes, bytes.Length, out dwWritten);
                    EndPagePrinter(hPrinter);
                    Marshal.FreeCoTaskMem(pUnmanagedBytes);
                }
                EndDocPrinter(hPrinter);
            }
            ClosePrinter(hPrinter);
        }
        return bSuccess;
    }
}
"@

try {
    Add-Type -TypeDefinition $rawPrinterHelperCode -Language CSharp
    Escrever-Log "RawPrinterHelper (winspool.drv) compilado com sucesso."
} catch {
    # Já compilado na sessão
}

# -----------------------------------------------------------------------------
# 2. TRÍPLICE TRAVA DO SASIII (BLOCKLIST + I/O EM PDV.FDB + SPOOLER + COOLDOWN)
# -----------------------------------------------------------------------------
$script:UltimoMomentoVendaAtiva = [DateTime]::MinValue
$script:UltimoTituloRegistrado = ""

function Testar-CaixaOcupado {
    # A) Inspeciona Processo e MainWindowTitle do DAM / SASIII
    $damProcesses = Get-Process -Name "SASIII", "PDV", "DAM*", "SGM*" -ErrorAction SilentlyContinue
    
    if ($damProcesses -and $damProcesses.Count -gt 0) {
        foreach ($proc in $damProcesses) {
            $title = $proc.MainWindowTitle
            if (![string]::IsNullOrWhiteSpace($title)) {
                if ($title -ne $script:UltimoTituloRegistrado) {
                    Escrever-Log "[DEBUG TITULO DAM] Processo: '$($proc.ProcessName)' | Título: '$title'"
                    $script:UltimoTituloRegistrado = $title
                }

                # Se contiver 'Livre' na tela, o operador NÃO está em venda: libera na hora!
                if ($title -match "(?i)livre") {
                    return @{ Ocupado = $false; Motivo = "Caixa Livre confirmado na tela ('$title')" }
                }

                # BLOCKLIST: Bloqueia se contiver termos de venda ativa
                if ($title -match "(?i)venda|cupom|subtotal|pagamento|nfc-e|cpf|fechamento|recebimento|total\s*:") {
                    $script:UltimoMomentoVendaAtiva = [DateTime]::Now
                    return @{ Ocupado = $true; Motivo = "DAM em venda ativa (Título: '$title')" }
                }
            }
        }
    }

    # B) Monitoramento de I/O no Banco de Dados Local (C:\DAM\SASIII\Arqs\pdv.fdb)
    $fdbCaminhos = @(
        "C:\DAM\SASIII\Arqs\pdv.fdb",
        "C:\DAM\SASIII_MEI\Arqs\pdv.fdb",
        "C:\DAM\SASIII MEI\Arqs\pdv.fdb",
        "C:\DAM\pdv.fdb"
    )

    foreach ($fdb in $fdbCaminhos) {
        if (Test-Path $fdb) {
            $ultimaModificacao = (Get-Item $fdb).LastWriteTime
            $segundosDesdeModificacao = ([DateTime]::Now - $ultimaModificacao).TotalSeconds

            if ($segundosDesdeModificacao -ge 0 -and $segundosDesdeModificacao -le 12) {
                $script:UltimoMomentoVendaAtiva = [DateTime]::Now
                $segFormatado = [Math]::Round($segundosDesdeModificacao, 1)
                return @{ Ocupado = $true; Motivo = "Gravação ativa no banco local ($segFormatado seg atrás em $fdb)" }
            }
        }
    }

    # C) Checagem do Spooler de Impressão do Windows (Get-PrintJob)
    try {
        $jobs = Get-PrintJob -PrinterName $PrinterName -ErrorAction SilentlyContinue
        if ($jobs -and $jobs.Count -gt 0) {
            $script:UltimoMomentoVendaAtiva = [DateTime]::Now
            return @{ Ocupado = $true; Motivo = "Spooler com $($jobs.Count) documento(s) em impressão" }
        }
    } catch {
        # Ignora caso impressora não esteja localmente instalada
    }

    # D) Cooldown Pós-Venda (10 segundos de calmaria após fechamento do cupom)
    $segundosDesdeUltimaVenda = ([DateTime]::Now - $script:UltimoMomentoVendaAtiva).TotalSeconds
    if ($segundosDesdeUltimaVenda -lt $CooldownSegundos) {
        $restante = [Math]::Ceiling($CooldownSegundos - $segundosDesdeUltimaVenda)
        return @{ Ocupado = $true; Motivo = "Cooldown de segurança ativo (Aguardando ${restante}s pós-venda)" }
    }

    return @{ Ocupado = $false; Motivo = "Caixa 100% Livre" }
}

# -----------------------------------------------------------------------------
# 3. COMUNICAÇÃO HTTP COM O SERVIDOR CENTRAL NA NUVEM
# -----------------------------------------------------------------------------
$script:UrlCentralAtiva = $ServerUrl

function Obter-ProximoJob {
    try {
        $url = "$script:UrlCentralAtiva/api/impressao/proximo"
        $headers = @{ 'x-api-key' = $ApiKey }
        $resposta = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -TimeoutSec 5 -ErrorAction Stop
        if ($resposta -and $resposta.job) {
            return $resposta.job
        }
        return $null
    } catch {
        # Loga apenas se for erro diferente de 404/vazio
    }
    return $null
}

function Atualizar-StatusJob {
    param(
        [Parameter(Mandatory=$true)][string]$Id,
        [Parameter(Mandatory=$true)][string]$Status,
        [string]$Erro = $null
    )
    $payload = @{
        id = $Id
        status = $Status
        erro = $Erro
    } | ConvertTo-Json

    try {
        $url = "$script:UrlCentralAtiva/api/impressao/status"
        $headers = @{ 'x-api-key' = $ApiKey }
        Invoke-RestMethod -Uri $url -Headers $headers -Method Post -Body $payload -ContentType "application/json; charset=utf-8" -TimeoutSec 5 -ErrorAction Stop | Out-Null
        return $true
    } catch {
        Escrever-Log "Falha ao enviar status do job $Id para o servidor central: $($_.Exception.Message)" "AVISO"
        return $false
    }
}

# -----------------------------------------------------------------------------
# 4. LOOP PRINCIPAL DO WORKER
# -----------------------------------------------------------------------------
Escrever-Log "Worker operacional. Conectado ao Servidor Central $ServerUrl"

while ($true) {
    try {
        # 1. Verifica se o Caixa 1 está em operação
        $estado = Testar-CaixaOcupado

        if ($estado.Ocupado) {
            Start-Sleep -Milliseconds $IntervaloChecagemMs
            continue
        }

        # 2. Caixa 100% Livre! Puxa o próximo job da fila no servidor central
        $job = Obter-ProximoJob

        if ($job) {
            Escrever-Log "📥 Pedido recebido! ID: $($job.id) | Pedido: #$($job.pedido_id) | Cliente: '$($job.cliente_nome)'"

            # Revalida se uma venda não começou neste exato milissegundo
            $recheca = Testar-CaixaOcupado
            if ($recheca.Ocupado) {
                Escrever-Log "⚠️ Venda iniciada no caixa antes da impressão! Revertendo para PENDENTE..." "AVISO"
                Atualizar-StatusJob -Id $job.id -Status "PENDENTE" -Erro "Venda iniciada no caixa"
                Start-Sleep -Milliseconds $IntervaloChecagemMs
                continue
            }

            # Decodifica os bytes ESC/POS
            $base64 = $job.dados_formatados_escpos
            if ([string]::IsNullOrWhiteSpace($base64)) {
                Escrever-Log "❌ Buffer ESC/POS vazio no job $($job.id)" "ERRO"
                Atualizar-StatusJob -Id $job.id -Status "ERRO" -Erro "Buffer ESC/POS nulo"
                continue
            }

            $bytesEscPos = [System.Convert]::FromBase64String($base64)
            $docName = "Comanda WhatsApp - Pedido #$($job.pedido_id)"

            # 3. Disparo no Win32 RAW Spooler (winspool.drv)
            Escrever-Log "🖨️ Despachando $($bytesEscPos.Length) bytes para impressora '$PrinterName'..."
            $sucesso = [RawPrinterHelper]::SendBytesToPrinter($PrinterName, $bytesEscPos, $docName)

            if ($sucesso) {
                Escrever-Log "✅ Comanda impressa com sucesso no Spooler da $PrinterName!"
                Atualizar-StatusJob -Id $job.id -Status "IMPRESSO"
            } else {
                Escrever-Log "❌ Falha no RawPrinterHelper ao enviar para '$PrinterName'! Revertendo para PENDENTE..." "ERRO"
                Atualizar-StatusJob -Id $job.id -Status "PENDENTE" -Erro "Falha no envio do RawPrinterHelper para $PrinterName"
            }
        }
    } catch {
        Escrever-Log "Exceção no ciclo principal: $_" "ERRO"
        Start-Sleep -Seconds 3
    }

    Start-Sleep -Milliseconds $IntervaloChecagemMs
}
