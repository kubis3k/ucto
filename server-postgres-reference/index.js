const express = require("express");
const app = express();

app.use(express.json());

app.use("/api/documents", require("./routes/documents"));
app.use("/api/postings", require("./routes/postings"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api", require("./routes/misc"));   // /api/accounts, /api/periods

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Ucetni API bezi na http://localhost:${PORT}`));
