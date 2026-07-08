import type { ErrorHandler } from "hono";

const handler: ErrorHandler = (error, c) =>
  c.render(
    <main className="grid min-h-screen place-items-center bg-slate-50 text-slate-950">
      <section className="border border-red-700 bg-white p-8 shadow-[6px_6px_0_#b91c1c]">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-red-700">Error</p>
        <h1 className="mt-3 text-2xl font-semibold">Trace UI failed</h1>
        <pre className="mt-4 max-w-2xl overflow-auto border border-slate-300 bg-slate-50 p-4 text-xs">
          {error instanceof Error ? error.message : String(error)}
        </pre>
      </section>
    </main>,
    { title: "Error - Gestalt Trace" }
  );

export default handler;
