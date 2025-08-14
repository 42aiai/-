const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// このログはRenderのログ画面に表示されるはず
console.log('--- Server script is starting up ---');

// ルートURLにアクセスがあった場合のテスト用応答
app.get('/', (req, res) => {
  res.send('Test server is running!');
});

// サーバーを起動
app.listen(PORT, () => {
  // このログが表示されれば、サーバー起動は完全に成功
  console.log(`--- Server successfully started and listening on port ${PORT} ---`);
});

console.log('--- Server script setup is complete, waiting for connections ---');