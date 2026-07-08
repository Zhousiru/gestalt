import { streamSSE } from "hono/streaming";
import { createRoute } from "honox/factory";
import { resolveGestaltHome } from "../lib/gestaltHome";
import { watchGestaltHome } from "../lib/watch";

export default createRoute((c) => {
  const home = resolveGestaltHome();
  let sequence = 0;

  return streamSSE(c, async (stream) => {
    const write = async (event: string, data: unknown) => {
      sequence += 1;
      await stream.writeSSE({
        id: String(sequence),
        event,
        data: JSON.stringify(data)
      });
    };

    await write("ready", {
      home: home.root,
      at: new Date().toISOString()
    });

    const watcher = watchGestaltHome(home, (kind) => {
      void write("snapshot_changed", {
        kind,
        at: new Date().toISOString()
      });
    });

    stream.onAbort(() => {
      watcher.close();
    });

    while (true) {
      await stream.sleep(15_000);
      await write("heartbeat", { at: new Date().toISOString() });
    }
  });
});
