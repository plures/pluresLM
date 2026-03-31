declare module "openclaw/plugin-sdk" {
  export interface OpenClawPluginApi {
    pluginConfig: unknown;
    logger: { info: (msg: string) => void; warn: (msg: string) => void };

    resolvePath: (p: string) => string;

    registerTool: (
      tool: {
        name: string;
        label?: string;
        description?: string;
        parameters: unknown;
        execute: (id: string, params: unknown) => Promise<unknown> | unknown;
      },
      meta?: { name: string },
    ) => void;

    registerCli: (
      fn: (ctx: { program: unknown }) => void,
      meta?: { commands: string[] },
    ) => void;

    registerService: (svc: {
      id: string;
      start: () => Promise<void> | void;
      stop: () => Promise<void> | void;
    }) => void;

    on: (event: string, handler: (event: unknown) => Promise<unknown> | unknown) => void;
  }
}
