/* Firebase web config.
   These values are NOT secrets — they identify the project, they do not grant access.
   Access is controlled by firestore.rules and storage.rules.

   Get them from:  Firebase console → Project settings (gear) → Your apps → Web app → Config
   If you have not created a web app yet, click "</>" on that page first.

   Leave this file as-is and the app still works — it just will not save anything. */
window.FIREBASE_CONFIG = {
  apiKey:            "PASTE_API_KEY",
  authDomain:        "pdf2model.firebaseapp.com",
  projectId:         "pdf2model",
  storageBucket:     "pdf2model.firebasestorage.app",
  messagingSenderId: "PASTE_SENDER_ID",
  appId:             "PASTE_APP_ID"
};
