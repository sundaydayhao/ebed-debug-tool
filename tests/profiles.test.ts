import test from "node:test";
import assert from "node:assert/strict";
import {
  newProfile,
  serializeProfiles,
  parseProfiles,
  profileKey,
  loadProfiles,
  prepareCommand,
} from "../src/workspace/profiles";
test("profile persistence round trip preserves settings and commands but strips secrets and unknown fields", () => {
  const p = newProfile("mqtt");
  p.config.url = "mqtt://user:secret@localhost:1883";
  p.config.password = "password";
  p.config.arbitraryCode = "ignored";
  p.commands.push({
    id: "cmd",
    name: "Read",
    payload: "41 54",
    format: "hex",
    ending: "",
  });
  const text = serializeProfiles([p]);
  assert.ok(!/secret|password|ignored/.test(text));
  const profiles = parseProfiles(text);
  assert.equal(profiles[0].config.url, "mqtt://localhost:1883");
  assert.equal(profiles[0].commands[0].payload, "41 54");
  assert.equal(profiles[0].id, p.id);
});
test("imports reject duplicate IDs and oversized/untrusted schemas", () => {
  const p = newProfile("tcp");
  assert.throws(
    () => parseProfiles(JSON.stringify({ version: 1, profiles: [p, p] })),
    /重复/,
  );
  assert.throws(
    () => parseProfiles(JSON.stringify({ version: 2, profiles: [p] })),
    /版本/,
  );
  assert.throws(
    () =>
      parseProfiles(
        JSON.stringify({ version: 1, profiles: [{ ...p, kind: "__proto__" }] }),
      ),
    /格式/,
  );
  assert.throws(() => parseProfiles("x".repeat(2097153)), /2 MB/);
});
test("corrupt persisted data is retained as a recovery copy, storage failure falls back to memory", () => {
  const map = new Map([[profileKey, "{corrupt"]]);
  const result = loadProfiles({
    getItem: (k) => map.get(k) || null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  });
  assert.equal(map.get(`${profileKey}.recovery`), "{corrupt");
  assert.ok(result.warning);
  assert.equal(result.profiles.length, 1);
  const failed = loadProfiles({
    getItem: () => "{corrupt",
    setItem: () => {
      throw new Error("full");
    },
  });
  assert.equal(failed.writable, false);
});
test("a send plan validates complete commands before starting and applies line endings only to text", () => {
  const command = {
    id: "1",
    name: "AT",
    payload: "AT",
    format: "text" as const,
    ending: "\r\n" as const,
  };
  assert.equal(prepareCommand(command).payload, "AT\r\n");
  assert.equal(
    prepareCommand({ ...command, format: "hex", payload: "41 54" }).payload,
    "41 54",
  );
  assert.throws(() =>
    prepareCommand({ ...command, format: "hex", payload: "4Q" }),
  );
  assert.throws(() =>
    prepareCommand({ ...command, format: "json", payload: "{bad}" }),
  );
});
