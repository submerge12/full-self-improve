import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
  createWindowsHealthLogger,
  loadWindowsLoggerConfig,
  type IdleStateProvider,
  type VisibleAlertClient
} from "../src/health-extensions/windows-logger.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const configPath = parseConfigPath(process.argv.slice(2));
  const config = loadWindowsLoggerConfig(JSON.parse(await readFile(configPath, "utf8")) as unknown);
  const logger = createWindowsHealthLogger({
    config,
    idleStateProvider: createWindowsLastInputIdleProvider(),
    visibleAlertClient: config.visibleAlert.channel === "powershell" ? createPowerShellAlertClient() : undefined,
    onError: (error) => {
      process.stderr.write(`${safeErrorMessage(error)}\n`);
    }
  });

  await logger.tick();
  await logger.start();
  await new Promise<never>(() => undefined);
}

function parseConfigPath(args: readonly string[]): string {
  const index = args.indexOf("--config");
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new Error("Usage: npm exec tsx scripts/health-windows-logger.ts -- --config <configPath>");
  }
  return value;
}

function createWindowsLastInputIdleProvider(): IdleStateProvider {
  return {
    read: async () => {
      if (process.platform !== "win32") {
        throw new Error("Windows idle provider requires Windows.");
      }
      const { stdout } = (await execFileAsync("powershell.exe", idleStatePowerShellArgs(), {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true
      })) as { stdout: string };
      const idleDurationMs = Number(stdout.trim());
      if (!Number.isFinite(idleDurationMs) || idleDurationMs < 0) {
        throw new Error("Windows idle provider returned an invalid idle duration.");
      }
      return { idleMs: idleDurationMs, now: new Date().toISOString() };
    }
  };
}

function createPowerShellAlertClient(): VisibleAlertClient {
  return {
    show: async ({ title, body }) => {
      if (process.platform !== "win32") {
        process.stdout.write(`${body.replace(/[\r\n]+/g, " ").trim()}\n`);
        return;
      }
      await execFileAsync("powershell.exe", alertPowerShellArgs(title, body), {
        timeout: 15_000,
        windowsHide: true
      });
    }
  };
}

function idleStatePowerShellArgs(): readonly string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    [
      "$signature = @'",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public static class KnowledgeLoopIdleTime {",
      "  [StructLayout(LayoutKind.Sequential)]",
      "  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }",
      "  [DllImport(\"user32.dll\")]",
      "  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);",
      "}",
      "'@",
      "Add-Type -TypeDefinition $signature",
      "$info = New-Object KnowledgeLoopIdleTime+LASTINPUTINFO",
      "$info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)",
      "if (-not [KnowledgeLoopIdleTime]::GetLastInputInfo([ref]$info)) { throw 'GetLastInputInfo failed' }",
      "$elapsed = [Environment]::TickCount64 - [int64]$info.dwTime",
      "if ($elapsed -lt 0) { $elapsed = 0 }",
      "[Console]::WriteLine($elapsed)"
    ].join("; ")
  ];
}

function alertPowerShellArgs(title: string, body: string): readonly string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($args[1], $args[0]) | Out-Null",
    title,
    body
  ];
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  process.stderr.write(`${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
