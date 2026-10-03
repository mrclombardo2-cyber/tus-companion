import { defineConfig } from "@playwright/test";
export default defineConfig({testDir:"./tests",testMatch:"ui.spec.js",workers:1,retries:0,reporter:"line",use:{baseURL:"http://127.0.0.1:4173",browserName:"chromium",serviceWorkers:"block"}});
