// Test automatici di Match Point Coach: aprono l'app in un browser vero, a larghezza telefono
const { defineConfig } = require("@playwright/test");
// stesso fuso orario per il test e per il browser: gli orari fissati nei test valgono uguali ovunque
process.env.TZ = "UTC";
module.exports = defineConfig({
  testDir: "tests",
  timeout: 60000,
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:4173", viewport: { width: 400, height: 900 }, locale: "it-IT", timezoneId: "UTC" },
  webServer: { command: "python3 -m http.server 4173 --bind 127.0.0.1", url: "http://127.0.0.1:4173/index.html", reuseExistingServer: true, stdout: "ignore", stderr: "ignore" }
});
