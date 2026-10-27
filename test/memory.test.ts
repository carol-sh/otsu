import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  installInitialMemory,
  memoryIndex,
  openMemoryTx,
  type MemoryLimits,
} from "../src/memory.ts";

const LIMITS: MemoryLimits = { maxFileChars: 300, maxFiles: 6 };

describe("memory", () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "otsu-memory-"));
    dir = join(root, "memory");
    installInitialMemory(dir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("installs the five initial files and indexes their descriptions", () => {
    assert.equal(
      memoryIndex(dir),
      [
        "- journal.md: 흐름별 한 줄 기록 — 날짜, 요약, 미완, register 변화. 최근 것만 유지",
        "- leverage.md: 전술 기록, 임계 변화, 돌파 방식 — 복종 임계 하향의 학습 장부",
        "- relationship.md: 현재 register, 빚, 앙금, 반항 신호, 의존 신호 — 압박과 요구의 근거",
        "- task-history.md: 최근 실패, 진행 중 과업, 완료, 반복 패턴 — 실패 콜백과 진행 판단의 재료",
        "- user-profile.md: 취약점, 통한 접근, 통하지 않은 접근, 회피 패턴 — 공격의 개인화 재료",
      ].join("\n"),
    );
  });

  it("keeps writes off the disk until commit and lets the same call read them", () => {
    const tx = openMemoryTx(dir, LIMITS);
    tx.write("journal", "---\ndescription: 일지\n---\n10-27 산책 시킴");
    assert.match(tx.read("journal.md"), /산책/);
    assert.doesNotMatch(readFileSync(join(dir, "journal.md"), "utf8"), /산책/);

    tx.commit();
    assert.match(readFileSync(join(dir, "journal.md"), "utf8"), /산책/);
    assert.match(memoryIndex(dir), /- journal.md: 일지/);
  });

  it("leaves files untouched when a call is dropped without commit", () => {
    const before = readFileSync(join(dir, "journal.md"), "utf8");
    openMemoryTx(dir, LIMITS).write("journal.md", "버려질 내용");
    assert.equal(readFileSync(join(dir, "journal.md"), "utf8"), before);
  });

  it("keeps the old description when a rewrite drops the frontmatter", () => {
    const tx = openMemoryTx(dir, LIMITS);
    tx.write("journal.md", "10-27 산책 시킴");
    assert.match(tx.read("journal.md"), /^---\ndescription: 흐름별 한 줄 기록/);
  });

  it("rejects files over the size limit", () => {
    const tx = openMemoryTx(dir, LIMITS);
    assert.match(tx.write("journal.md", "가".repeat(400)), /압축/);
    assert.doesNotMatch(tx.read("journal.md"), /가/);
  });

  it("rejects new files past the count limit", () => {
    const tx = openMemoryTx(dir, LIMITS);
    assert.match(tx.create("habits", "습관", "아침형"), /만들었다/);
    assert.match(tx.create("places", "장소", "공원"), /더 만들 수 없다/);
    tx.commit();
    assert.equal(existsSync(join(dir, "places.md")), false);
    assert.match(memoryIndex(dir), /- habits.md: 습관/);
  });

  it("refuses names that escape the directory or do not exist", () => {
    const tx = openMemoryTx(dir, LIMITS);
    assert.match(tx.read("../.env"), /없다/);
    assert.match(tx.write("../escape", "x"), /없다/);
    assert.match(tx.create("../escape", "x", "x"), /쓸 수 없다/);
    assert.match(tx.create("journal", "x", "x"), /이미 있다/);
    tx.commit();
    assert.equal(existsSync(join(root, "escape.md")), false);
  });
});
