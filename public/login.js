const API_BASE = "/auth";

document.addEventListener("DOMContentLoaded", () => {

    const form = document.getElementById("loginForm");
    const email = document.getElementById("email");
    const password = document.getElementById("password");
    const errorBox = document.getElementById("errorBox");

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        errorBox.textContent = "";

        if (!email.value || !password.value) {
            errorBox.textContent = "لطفاً ایمیل و رمز عبور را وارد کنید.";
            return;
        }

        try {
            const res = await fetch(`${API_BASE}/login`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    username: email.value,   // ← اصلاح شد
                    password: password.value
                })
            });

            const data = await res.json();

            if (!data.ok) {
                errorBox.textContent = data.error || "ورود ناموفق بود.";
                return;
            }

            localStorage.setItem("eclipse:token", data.token);

            window.location.href = "/chat.html";

        } catch (err) {
            errorBox.textContent = "خطا در اتصال به سرور";
            console.error(err);
        }
    });
});