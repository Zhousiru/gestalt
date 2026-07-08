import { createRoute } from "honox/factory";
import { resolveGestaltHome } from "../../lib/gestaltHome";

export default createRoute((c) => {
  c.header("Cache-Control", "no-store");
  return c.json({
    ok: true,
    home: resolveGestaltHome(),
    at: new Date().toISOString()
  });
});
