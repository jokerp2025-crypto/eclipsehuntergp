
    document.addEventListener("DOMContentLoaded", () => {
      const form = document.getElementById("registerForm");
      const msg = document.getElementById("msg");

      function showMessage(text, ok) {
        msg.textContent = text;
        msg.style.color = ok ? "var(--success)" : "var(--danger)";
      }

      form.addEventListener("submit", async (e) => {
        e.preventDefault();

        const displayName = document.getElementById("displayName").value.trim();
        const username = document.getElementById("username").value.trim();
        const password = document.getElementById("password").value.trim();

        // ===== FIXED: proper validation =====
        if (!displayName || !username || !password) {
          showMessage("⚠️ لطفاً همه فیلدها را کامل کنید", false);
          return;
        }

        showMessage("⌛ در حال ثبت‌نام...", true);

        try {
          const res = await fetch("/auth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ displayName, username, password })
          });

          let data = null;
          try { data = await res.json(); } catch (err) { data = null; }

          if (res.ok && data && (data.ok === true || data.ok)) {
            showMessage("✅ ثبت‌نام موفق! در حال انتقال...", true);
            setTimeout(() => (location.href = "/login.html"), 1200);
            return;
          }

          // handle different possible error strings that server might send
          const errCode = data && data.error ? data.error : null;
          if (errCode === "username_taken" || errCode === "username exists" || errCode === "user_exists") {
            showMessage("❌ این آیدی از قبل وجود دارد", false);
            return;
          }

          // fallback messages
          if (data && data.error) {
            showMessage("⚠️ خطا: " + data.error, false);
          } else if (!res.ok) {
            showMessage("⚠️ خطا: پاسخ ناموفق از سرور", false);
          } else {
            showMessage("⚠️ خطا: مشکل در سرور", false);
          }
        } catch (err) {
          console.error('Register error', err);
          showMessage("❌ خطا در ارتباط با سرور", false);
        }
      });
    });
  