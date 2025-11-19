const API_BASE = "/auth";

document.addEventListener("DOMContentLoaded", () => {

    const form = document.getElementById("registerForm");
    const nameEl = document.getElementById("name");
    const emailEl = document.getElementById("email");
    const passEl = document.getElementById("password");
    const errorBox = document.getElementById("errorBox");

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        errorBox.textContent = "";

        if (!nameEl.value || !emailEl.value || !passEl.value) {
            errorBox.textContent = "همه فیلدها باید پر شوند.";
            return;
        }

        try {
            const res = await fetch(`${API_BASE}/register`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    username: emailEl.value,       // ← اصلاح شد
                    password: passEl.value,
                    displayName: nameEl.value      // ← اصلاح شد
                })
            });

            const data = await res.json();

            if (!data.ok) {
                errorBox.textContent = data.error || "ثبت‌نام ناموفق بود.";
                return;
            }

            window.location.href = "/login.html";

        } catch (err) {
            errorBox.textContent = "خطای اتصال به سرور";
            console.error(err);
        }
    });
});