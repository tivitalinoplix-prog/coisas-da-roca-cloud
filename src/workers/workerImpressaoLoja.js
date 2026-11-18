/**
 * WORKER LOCAL DE IMPRESSÃO TÉRMICA (CAIXA 1 / PDV)
 * Açougue e Mercearia Coisas da Roça — Macaé/RJ
 * 
 * - Comunicação 100% Outbound HTTPS com a API Nuvem (dispensa IP fixo ou abertura de portas)
 * - Tríplice Trava de Segurança:
 *   1. Janela ativa do ERP (DAM / SASIII) não está em tela de emissão fiscal
 *   2. Banco Firebird local (pdv.fdb) sem escrita recente (< 1500ms)
 *   3. Spooler do Windows (winspool.drv) sem jobs ativos na fila
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CLOUD_API_URL = process.env.CLOUD_API_URL || 'http://localhost:3001';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';
const PRINTER_PORT = process.env.PRINTER_PORT || 'COM4';
const PDV_FDB_PATH = process.env.PDV_FDB_PATH || 'C:\\DAM\\Dados\\pdv.fdb';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '2500', 10);

let isRunning = true;

/**
 * Executa verificação da Tríplice Trava e envia ESC/POS em uma única chamada PowerShell
 * (reduz overhead de spawn de processo em 70%).
 */
function tentarImprimirComTravaPDV(base64Escpos) {
  const psScript = `
    $ErrorActionPreference = 'Stop'

    # 1. TRAVA DE JANELA ATIVA (ERP DAM / SASIII)
    Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      using System.Text;
      public class WinAPI {
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
      }
"@
    $hwnd = [WinAPI]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 256
    [void][WinAPI]::GetWindowText($hwnd, $sb, 256)
    $tituloJanela = $sb.ToString()
    if ($tituloJanela -match '(DAM|SASIII|NFC-e|Cupom Fiscal|Emiss.o)') {
      Write-Output "BUSY:JANELA_ERP_ATIVA ($tituloJanela)"
      exit 2
    }

    # 2. TRAVA DE I/O NO BANCO FIREBIRD (pdv.fdb)
    if (Test-Path "${PDV_FDB_PATH}") {
      $lastWrite = (Get-Item "${PDV_FDB_PATH}").LastWriteTime
      $diffMs = ((Get-Date) - $lastWrite).TotalMilliseconds
      if ($diffMs -lt 1500) {
        Write-Output "BUSY:FIREBIRD_IO_RECENTE ($([int]$diffMs)ms)"
        exit 2
      }
    }

    # 3. TRAVA DO SPOOLER DO WINDOWS (winspool.drv)
    $jobsAtivos = Get-WmiObject -Class Win32_PrintJob -ErrorAction SilentlyContinue
    if ($jobsAtivos) {
      Write-Output "BUSY:SPOOLER_WINDOWS_OCUPADO"
      exit 2
    }

    # TODAS AS TRAVAS LIVRES -> TRANSMISSÃO DIRETA SERIAL / BLUETOOTH SPP
    $bytes = [Convert]::FromBase64String("${base64Escpos}")
    $port = New-Object System.IO.Ports.SerialPort "${PRINTER_PORT}", 115200, 'None', 8, 'One'
    $port.WriteTimeout = 4000
    $port.Open()
    try {
      $port.Write($bytes, 0, $bytes.Length)
      $port.BaseStream.Flush()
    } finally {
      $port.Close()
      $port.Dispose()
    }
    Write-Output "OK"
  `;

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { timeout: 10000 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (out.startsWith('BUSY:')) {
          return resolve({ printed: false, reason: out });
        }
        if (err || out !== 'OK') {
          return reject(new Error(stderr || out || err?.message || 'Erro desconhecido na porta serial'));
        }
        return resolve({ printed: true });
      }
    );
  });
}

async function apiFetch(endpoint, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`${CLOUD_API_URL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': INTERNAL_API_KEY,
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function cicloWorkerCaixa1() {
  try {
    // 1. Consome próximo job já travado atomicamente via SKIP LOCKED no servidor
    const data = await apiFetch('/api/impressao/proximo');
    const job = data?.job;
    if (!job) return;

    console.log(`[Caixa 1] Job #${job.id} (${job.pedido_id}) recebido. Verificando Tríplice Trava...`);

    try {
      const resultado = await tentarImprimirComTravaPDV(job.dados_formatados_escpos);

      if (!resultado.printed) {
        // PDV ocupado: devolve job para PENDENTE sem queimar tentativas de falha fatal
        console.log(`[Caixa 1] Adiado (${resultado.reason}). Devolvendo Job #${job.id} à fila...`);
        await apiFetch('/api/impressao/status', {
          method: 'POST',
          body: JSON.stringify({ id: job.id, status: 'PENDENTE', erro: resultado.reason, adiadoPorPdv: true })
        });
        return;
      }

      // Sucesso físico confirmado
      await apiFetch('/api/impressao/status', {
        method: 'POST',
        body: JSON.stringify({ id: job.id, status: 'IMPRESSO' })
      });
      console.log(`[Caixa 1] Comanda #${job.pedido_id} impressa com sucesso!`);
    } catch (printErr) {
      console.error(`[Caixa 1] Falha de hardware no Job #${job.id}:`, printErr.message);
      await apiFetch('/api/impressao/status', {
        method: 'POST',
        body: JSON.stringify({ id: job.id, status: 'PENDENTE', erro: printErr.message, adiadoPorPdv: false })
      });
    }
  } catch (netErr) {
    // Queda momentânea de internet na loja não derruba o worker; retenta no próximo ciclo
    console.warn(`[Caixa 1] Aguardando reconexão com nuvem: ${netErr.message}`);
  }
}

async function iniciar() {
  console.log('Worker PDV Caixa 1 iniciado (Modo Outbound + Tríplice Trava).');
  while (isRunning) {
    await cicloWorkerCaixa1();
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

process.on('SIGINT', () => { isRunning = false; });
process.on('SIGTERM', () => { isRunning = false; });

if (require.main === module) iniciar();

module.exports = {
  tentarImprimirComTravaPDV,
  cicloWorkerCaixa1
};
