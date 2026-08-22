import fs from "fs";

fs.rmSync("./auth", { recursive: true, force: true });
console.log("Auth directory removed.");
