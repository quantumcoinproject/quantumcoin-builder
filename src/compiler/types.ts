// Compiler worker protocol + shared compile types (Mini §5.6, §6.2).

export type Severity = "error" | "warning";

export interface EditorDiagnostic {
  file: string; // workspace path, e.g. "Storage.sol"
  line: number; // 1-based
  column?: number; // 1-based
  endLine?: number;
  endColumn?: number;
  severity: Severity;
  message: string;
}

export interface CompiledContract {
  contractName: string;
  abi: unknown[];
  bytecode: string; // creation / init code, 0x-prefixed (evm.bytecode.object)
  deployedBytecode: string; // runtime code, 0x-prefixed (evm.deployedBytecode.object)
  metadata: string;
  sourcePath: string;
}

export interface CompileResult {
  contracts: CompiledContract[];
  diagnostics: EditorDiagnostic[];
  errorCount: number;
  warningCount: number;
}

export interface CompileSettings {
  optimizer: { enabled: boolean; runs: number };
  evmVersion?: string;
  remappings?: string[];
}

export const DEFAULT_SETTINGS: CompileSettings = {
  optimizer: { enabled: true, runs: 200 },
};

export type WorkerRequest =
  | { id: number; type: "ping" }
  | {
      id: number;
      type: "compile";
      sources: Record<string, string>;
      settings: CompileSettings;
    };

export type WorkerResponse =
  | { id: number; type: "pong" }
  | { id: number; type: "progress"; stage: string }
  | { id: number; type: "result"; result: CompileResult }
  | { id: number; type: "error"; message: string };
