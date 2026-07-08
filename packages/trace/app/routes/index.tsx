import { createRoute } from "honox/factory";
import TraceExplorer from "../islands/TraceExplorer";

export default createRoute((c) => {
  return c.render(<TraceExplorer />, { title: "Gestalt Trace" });
});
