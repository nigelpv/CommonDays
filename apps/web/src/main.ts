import { mount } from "svelte";
import "./app.css";
import "./admin.css";

const path = window.location.pathname.replace(/\/$/, "") || "/";

async function start() {
  const module = path === "/admin/login"
    ? await import("./lib/AdminLogin.svelte")
    : path === "/admin" || path.startsWith("/admin/reports")
      ? await import("./lib/AdminReports.svelte")
      : await import("./App.svelte");

  mount(module.default, { target: document.getElementById("app")! });
}

void start();
