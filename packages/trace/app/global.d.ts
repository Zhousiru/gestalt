import "@hono/react-renderer";

declare module "@hono/react-renderer" {
  interface Props {
    title?: string;
  }
}

declare module "hono" {
  interface Env {
    Variables: Record<string, never>;
    Bindings: Record<string, never>;
  }
}
