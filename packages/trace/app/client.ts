import { createClient } from "honox/client";

createClient({
  hydrate: async (element, root) => {
    const { hydrateRoot } = await import("react-dom/client");
    hydrateRoot(root, element);
  },
  createElement: async (type: unknown, props: unknown) => {
    const { createElement } = await import("react");
    return createElement(type as never, props as never);
  }
});
