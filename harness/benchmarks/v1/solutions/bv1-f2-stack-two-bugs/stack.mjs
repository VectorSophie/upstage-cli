export class Stack {
  constructor() { this.items = []; }
  push(x) { this.items.push(x); }
  pop() { return this.items.pop(); }
  size() { return this.items.length; }
}
