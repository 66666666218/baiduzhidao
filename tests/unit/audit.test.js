"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { EventBus } = require("../../electron/src/events/bus");
const { AuditLogger } = require("../../electron/src/audit/logger");

test("AuditLogger：审计事件落 JSONL（谁/何时/事件/载荷）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
  const bus = new EventBus();
  const auditor = new AuditLogger({ auditDir: dir, eventBus: bus, operator: "tester" });

  bus.emit("task.started", { taskId: "t1", taskName: "crawl" });
  bus.emit("task.failed", { taskId: "t1", taskName: "crawl", error: "网络中断" });
  bus.emit("answer.qualityChecked", { questionId: "q_1", decision: "REVIEW" });
  auditor.flushSync();

  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  const lines = fs.readFileSync(path.join(dir, files[0]), "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  const first = JSON.parse(lines[0]);
  assert.equal(first.event, "task.started");
  assert.equal(first.actor, "tester");
  assert.equal(first.taskId, "t1");
  assert.ok(first.at);
  const second = JSON.parse(lines[1]);
  assert.equal(second.error, "网络中断");
});

test("AuditLogger：非审计事件不落盘", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit2-"));
  const bus = new EventBus();
  const auditor = new AuditLogger({ auditDir: dir, eventBus: bus });
  bus.emit("some.unaudited.event", { x: 1 });
  auditor.flushSync();
  assert.equal(fs.readdirSync(dir).length, 0, "未订阅的事件不应产生文件");
});

test("AuditLogger：record 直接调用（供任务内点对点审计）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit3-"));
  const auditor = new AuditLogger({ auditDir: dir });
  auditor.record("answer.generated", { questionId: "q_9", model: "deepseek" });
  auditor.flushSync();
  const file = fs.readdirSync(dir)[0];
  const entry = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8").trim());
  assert.equal(entry.event, "answer.generated");
  assert.equal(entry.questionId, "q_9");
  assert.equal(entry.model, "deepseek");
});
