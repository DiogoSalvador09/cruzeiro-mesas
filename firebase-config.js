// Configuração do Firebase (Realtime Database).
// 1. https://console.firebase.google.com → Adicionar projeto (ex.: "cruzeiro-mesas")
// 2. Build → Realtime Database → Criar base de dados (europe-west1)
// 3. Definições do projeto → As tuas apps → Web → copiar o firebaseConfig para aqui
// Enquanto isto for `null`, a app funciona em modo local (sem sincronização entre aparelhos).
export const firebaseConfig = null;
/* Exemplo:
export const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "cruzeiro-mesas.firebaseapp.com",
  databaseURL: "https://cruzeiro-mesas-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "cruzeiro-mesas",
  storageBucket: "cruzeiro-mesas.appspot.com",
  messagingSenderId: "…",
  appId: "…"
};
*/
