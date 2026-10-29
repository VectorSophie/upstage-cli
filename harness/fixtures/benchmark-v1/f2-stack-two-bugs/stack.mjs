export class Stack {
  constructor() { this.items = []; }
  push(x) { this.items.push(x); }
  pop() { return this.items[this.items.length - 1]; } // BUG: peeks, does not remove
  size() { return this.items.length - 1; } // BUG: off by one
}
