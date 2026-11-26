// A small helper for building DOM without a framework.

type Child = Node | string | null | undefined | false;

export interface ElOptions {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, options: ElOptions = {}, children: Child[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title) node.title = options.title;
  for (const [name, value] of Object.entries(options.attrs ?? {})) node.setAttribute(name, value);
  for (const [type, handler] of Object.entries(options.on ?? {})) node.addEventListener(type, handler as EventListener);
  for (const child of children) if (child) node.append(child);
  return node;
}

/** Set text only when it changed, so a clock that ticks every frame does not thrash layout. */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}
