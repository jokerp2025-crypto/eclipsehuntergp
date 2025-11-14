
    (function(){
      const form = document.getElementById('loginForm');
      const msg = document.getElementById('message');

      // ✅ اگر قبلاً وارد شده باشد، مستقیم برو به چت
      const existingToken = localStorage.getItem('token') || sessionStorage.getItem('token');
      if (existingToken) {
        window.location.href = '/chat.html';
        return;
      }

      function showMessage(text, ok) {
        msg.textContent = text || '';
        msg.style.color = ok
          ? getComputedStyle(document.documentElement).getPropertyValue('--success')
          : getComputedStyle(document.documentElement).getPropertyValue('--danger');
      }

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        showMessage('', false);

        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const remember = document.getElementById('remember').checked;

        if (!username || !password) {
          showMessage('لطفاً همه‌ی فیلدهای مورد نیاز را پر کنید', false);
          return;
        }

        try {
          const res = await fetch('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
          });

          // parse JSON safely
          let data = null;
          try { data = await res.json(); } catch (err) { data = null; }

          if (res.ok && data && data.ok && data.token) {
            showMessage('ورود موفق — در حال انتقال...', true);

            try {
              if (remember) localStorage.setItem('token', data.token);
              else sessionStorage.setItem('token', data.token);
            } catch (e) {}

            setTimeout(() => {
              location.href = '/chat.html';
            }, 650);
            return;
          }

          // handle known server-side errors gracefully
          if (data && data.error) {
            let txt = data.error;
            if (data.error === 'user_not_found' || data.error === 'user_not_found') txt = 'کاربری با این نام یافت نشد';
            if (data.error === 'wrong_password' || data.error === 'invalid_credentials') txt = 'نام‌کاربری یا رمز عبور اشتباه است';
            if (data.error === 'missing_fields') txt = 'فیلدها تکمیل نشده‌اند';
            showMessage(txt, false);
            return;
          }

          // fallback: non-JSON or unexpected server response
          if (!res.ok) {
            showMessage('خطا در ورود — سرور پاسخ ناموفق داد', false);
          } else {
            showMessage('خطا در ورود', false);
          }
        } catch (err) {
          console.error('Login fetch error', err);
          showMessage('خطا در اتصال به سرور', false);
        }
      });
    })();