import { expect, test } from "bun:test";
import { greet } from "../src/greet";

test("greets by name", () => {
  expect(greet("ada")).toBe("Hello, ada!");
});

test("shouts when asked", () => {
  // @ts-expect-error the option does not exist yet: this is the factory's job
  expect(greet("ada", { shout: true })).toBe("HELLO, ADA!");
});
