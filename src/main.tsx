import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import App from './App';
import './index.css';
import { startEventSubscriptions } from './stores/events';

startEventSubscriptions();

const root = document.getElementById('root');
if (root) ReactDOM.createRoot(root).render(<App />);
