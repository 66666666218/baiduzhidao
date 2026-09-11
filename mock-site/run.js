"use strict";

// 独立启动模拟站：node mock-site/server.js
const { MockSite } = require("./server");

const port = Number(process.env.MOCK_PORT) || 8931;
const site = new MockSite({ cdpUrl: process.env.MOCK_CDP || "http://127.0.0.1:9333" });

site.listen(port).then(() => {
  console.log(`[mock-site] http://127.0.0.1:${site.port}/hd/21th_activity/`);
  console.log(`[mock-site] bitbrowser api = http://127.0.0.1:${site.port}`);
  console.log(`[mock-site] llm api = http://127.0.0.1:${site.port}/v1/chat/completions`);
});
