
    async function submitAccess() {
      const msg = document.getElementById("msg");
      msg.textContent = "";

      const sitePassword = document.getElementById("sitePass").value.trim();

      if (!sitePassword) {
        msg.textContent = "لطفاً رمز را وارد کنید";
        return;
      }

      try {
        const res = await fetch('https://eclipsehuntergp.onrender.com/auth/access', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sitePassword })
});

        let data = null;
        try {
          data = await res.json();
        } catch (e) {
          msg.textContent = "خطا در ارتباط با سرور";
          return;
        }

        if (!data.ok) {
          if (data.error === 'invalid_site_password') {
            msg.textContent = "رمز اشتباه است";
          } else if (data.error === 'missing_password') {
            msg.textContent = "رمز وارد نشده است";
          } else {
            msg.textContent = "خطای ناشناخته";
          }
          return;
        }

        // موفقیت
        msg.style.color = "#66ff99";
        msg.textContent = "✔ ورود موفق — در حال انتقال...";
        setTimeout(() => {
          window.location.href = "/login.html";
        }, 700);

      } catch (err) {
        msg.textContent = "خطای ارتباط با سرور";
      }
}
