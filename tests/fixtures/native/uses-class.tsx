import { Text } from "@xp/runtime";

class Counter {
  n = 0;
}

export default function UsesClass() {
  return <Text>{new Counter().n}</Text>;
}
