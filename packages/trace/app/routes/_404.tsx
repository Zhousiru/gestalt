import type { NotFoundHandler } from "hono";

const handler: NotFoundHandler = (c) =>
  c.render(
    <main className="grid min-h-screen place-items-center bg-slate-50 text-slate-950">
      <section className="border border-slate-950 bg-white p-8 shadow-[6px_6px_0_#0f172a]">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-slate-500">404</p>
        <h1 className="mt-3 text-2xl font-semibold">Route not found</h1>
        <a className="mt-6 inline-block border border-slate-950 px-4 py-2 text-sm" href="/">
          Back to traces
        </a>
      </section>
    </main>,
    { title: "Not found - Gestalt Trace" }
  );

export default handler;
