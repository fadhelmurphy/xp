// Implementasi acuan untuk SDK native: menerapkan batch operasi ke tree view.
// Swift/Kotlin melakukan hal yang sama, lalu merender tree ini dengan SwiftUI/Compose.
import type { Batch, HandlerRef } from "../runtime/protocol";

export type NativeNode = { id: number; type: string; props: Record<string, unknown>; children: number[] };

export class NativeTree {
  readonly nodes = new Map<number, NativeNode>([[0, { id: 0, type: "#root", props: {}, children: [] }]]);
  version = 0;

  apply(batch: Batch) {
    if (batch.v !== 1) throw new Error(`Protokol ${batch.v} tidak didukung SDK ini`);
    for (const op of batch.ops) {
      switch (op[0]) {
        case "create":
          this.nodes.set(op[1], { id: op[1], type: op[2], props: {}, children: [] });
          break;
        case "props": {
          const n = this.must(op[1]);
          for (const [k, v] of Object.entries(op[2])) (v === null ? delete n.props[k] : (n.props[k] = v));
          break;
        }
        case "children":
          this.must(op[1]).children = op[2];
          break;
        case "delete":
          this.nodes.delete(op[1]);
          break;
      }
    }
    this.version++;
  }

  private must(id: number) {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`Node ${id} tidak ada (op tidak konsisten)`);
    return n;
  }

  /** Node yang terlihat dari root (yang benar-benar dirender). */
  *walk(id = 0): Generator<NativeNode> {
    const n = this.must(id);
    yield n;
    for (const c of n.children) yield* this.walk(c);
  }

  byTestID(testID: string) {
    for (const n of this.walk()) if (n.props.testID === testID) return n;
    return undefined;
  }

  /** Teks sebuah node = gabungan semua #text di bawahnya (seperti Text di SwiftUI). */
  text(n: NativeNode): string {
    if (n.type === "#text") return String(n.props.value ?? "");
    return n.children.map((c) => this.text(this.must(c))).join("");
  }

  handler(n: NativeNode, prop: string) {
    return (n.props[prop] as HandlerRef | undefined)?.$fn;
  }

  /** Semua node yang tersisa harus terjangkau dari root (tidak ada node bocor). */
  orphans() {
    const reachable = new Set([...this.walk()].map((n) => n.id));
    return [...this.nodes.keys()].filter((id) => !reachable.has(id));
  }
}
