// Minimal in-memory DOM for logic tests, NOT a browser/layout emulator.
export class Element {
  constructor(tag, attrs = {}, style = {}) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.style = style;
    this.childNodes = [];
    this.events = {};
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    this.classList = {
      toggle: (name, force) => {
        const names = new Set((this.className || "").split(/\s+/).filter(Boolean));
        const enabled = force === undefined ? !names.has(name) : Boolean(force);
        if (enabled) names.add(name); else names.delete(name);
        this.className = [...names].join(" ");
        return enabled;
      },
      contains: name => (this.className || "").split(/\s+/).includes(name)
    };
  }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  set className(v) { this.attrs.class = v; }
  get className() { return this.attrs.class || ""; }
  set id(v) { this.attrs.id = v; }
  get id() { return this.attrs.id || ""; }
  set textContent(v) { this.childNodes = []; if (v !== "") this.addText(String(v)); }
  get textContent() { return this.childNodes.map(n => n.nodeType === 3 ? n.nodeValue : n.textContent).join(""); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
  appendChild(node) {
    this.childNodes.push(node);
    node.parentElement = this;
    node.ownerDocument = this.ownerDocument;
    return node;
  }
  addText(value) { return this.appendChild({ nodeType: 3, nodeValue: value }); }
  attachShadow() { this.testShadow = new Element("shadow-root"); return this.testShadow; }
  addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
  fire(type, data = {}) { for (const fn of this.events[type] || []) fn({ stopPropagation() {}, preventDefault() {}, ...data }); }
  click() { if (!this.disabled) this.fire("click"); }
  focus() {}
  remove() {
    if (this.parentElement) this.parentElement.childNodes = this.parentElement.childNodes.filter(n => n !== this);
    this.isConnected = false;
  }
  matches(selector) {
    return selector.split(",").some(part => {
      const rule = part.trim();
      if (rule === "*") return true;
      if (rule.startsWith("#")) return this.id === rule.slice(1);
      const tag = rule.match(/^[a-z][a-z0-9-]*/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const attrs = [...rule.matchAll(/\[([\w-]+)(?:(\^=|\*=|=)"([^"]*)")?\]/g)];
      return !!(tag || attrs.length) && attrs.every(([, key, op, expected]) => {
        const actual = this.getAttribute(key);
        if (!op) return actual !== null;
        if (actual === null) return false;
        return op === "=" ? actual === expected : op === "^=" ? actual.startsWith(expected) : actual.includes(expected);
      });
    });
  }
  closest(selector) { for (let n = this; n; n = n.parentElement) if (n.matches?.(selector)) return n; return null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [ ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() {
    if (this.style.display === "contents" || this.style.display === "none") return { width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 };
    const left = Number.isFinite(this.style.left) ? this.style.left : 0;
    const top = Number.isFinite(this.style.top) ? this.style.top : 0;
    const width = Number.isFinite(this.style.width) ? this.style.width : 200;
    const height = Number.isFinite(this.style.height) ? this.style.height : 24;
    return { width, height, left, right: left + width, top, bottom: top + height };
  }
}

export function makeDocument() {
  const doc = {
    nodeType: 9,
    defaultView: { getComputedStyle: node => ({ display: "block", visibility: "visible", opacity: "1", ...node.style }) },
    createElement(tag) { const n = new Element(tag); n.ownerDocument = doc; return n; },
    querySelectorAll(selector) { return doc.body.querySelectorAll(selector); }
  };
  doc.body = doc.createElement("body");
  doc.documentElement = doc.body;
  return doc;
}

export function append(parent, tag, attrs = {}, text = "", style = {}) {
  const node = new Element(tag, attrs, style);
  parent.appendChild(node);
  if (text) node.addText(text);
  return node;
}
