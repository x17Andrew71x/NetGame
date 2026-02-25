const http = require("http");

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.end();

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("You reached server abc\n");
});

server.listen(3000, "0.0.0.0", () => console.log("HTTP on :3000"));
