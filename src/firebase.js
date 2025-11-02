// Use the compat layer to preserve the older namespaced API (firebase.firestore(), firebase.auth(), etc.)
import firebase from 'firebase/compat/app'
import 'firebase/compat/firestore'
import 'firebase/compat/auth'

//you can either add your firebase config directly like in the tutorial or can also add it as an
//json string like here https://create-react-app.dev/docs/adding-custom-environment-variables/

const config = {

  apiKey: "AIzaSyCM-n5j12-j9lJRX2Z1uUxlxqhm6vzDrAw",
  authDomain: "cntp-d3a80.firebaseapp.com",
  projectId: "cntp-d3a80",
  storageBucket: "cntp-d3a80.firebasestorage.app",
  messagingSenderId: "667067043269",
  appId: "1:667067043269:web:85be737790b95fd11c0fac",
  measurementId: "G-FW4EBEWJQ6"
};

const firebaseConfig = config;
// Initialize Firebase (compat)
firebase.initializeApp(firebaseConfig)

export const db = firebase.firestore()
export const auth = firebase.auth()
export default firebase
