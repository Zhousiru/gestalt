import {
  Bash,
  type CustomCommand,
  type IFileSystem
} from "just-bash";

export interface BashCommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PhaseBash {
  readonly commands: BashCommandResult[];
  exec(command: string, signal?: AbortSignal): Promise<BashCommandResult>;
}

export interface CreatePhaseBashOptions {
  fs: IFileSystem;
  cwd?: string;
  customCommands?: CustomCommand[];
}

/**
 * Creates one phase-scoped shell. Shell state resets per exec while the VFS is
 * shared for the lifetime of this object.
 */
export function createPhaseBash(options: CreatePhaseBashOptions): PhaseBash {
  const commands: BashCommandResult[] = [];
  const bash = new Bash({
    fs: options.fs,
    cwd: options.cwd ?? "/",
    ...(options.customCommands
      ? { customCommands: options.customCommands }
      : {}),
    defenseInDepth: true
  });

  return {
    commands,

    async exec(command, signal) {
      const result = await bash.exec(command, {
        ...(signal ? { signal } : {})
      });
      const commandResult = {
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      };
      commands.push(commandResult);
      return commandResult;
    }
  };
}
