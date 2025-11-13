Eclipse Hunter - Minimal setup
Files generated: server_complete.js (server), public/chat.html, public/chat.js
Instructions:
1. Place server file in project root as server.js (overwrite previous).
2. Ensure public/chat.html and public/chat.js are in public/.
3. Create folder public/uploads and make it writable.
4. Install dependencies:
   npm install express mongoose multer cors socket.io dotenv
5. Run MongoDB locally or set MONGO_URI in .env
6. Start server: node server.js
7. Open /login.html then register, then chat.
