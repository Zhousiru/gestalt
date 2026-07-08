import { reactRenderer } from "@hono/react-renderer";
import { Link, Script } from "honox/server";

export default reactRenderer(({ children, title }) => {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content="light" />
        <Link href="/app/style.css" rel="stylesheet" />
        <Script src="/app/client.ts" async />
        <title>{title ?? "Gestalt Trace"}</title>
      </head>
      <body>{children}</body>
    </html>
  );
});
