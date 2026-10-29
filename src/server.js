import { app } from "./app.js";
import { config } from "./config.js";

app.listen(config.port, () => {
  console.log(`SISLAR API em http://localhost:${config.port}`);
});
