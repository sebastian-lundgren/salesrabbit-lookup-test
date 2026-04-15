const express = require("express");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("lookup-test kjører");
});

app.post("/lookup-1881", (req, res) => {
  const { leadId, street1, city, zip } = req.body || {};

  console.log("Innkommende data:", { leadId, street1, city, zip });

  res.json({
    match: true,
    firstName: "Test",
    lastName: "Person",
    phone: "90000000"
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server kjører på port ${port}`);
});
