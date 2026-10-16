import './App.css';
import { HashRouter, Route, Routes } from 'react-router-dom';
import LoginPage from './pages/login-page';
import MainPage from './pages/main-page';
import SignedOutRedirect from './components/signed-out-redirect';
import QuitGuard from './components/quit-guard';
import NoticeList from './components/notice-list';

export default function App() {
    return (
        <HashRouter>
            <SignedOutRedirect />
            <Routes>
                <Route path='/' element={<LoginPage />} />
                <Route path='/main' element={<MainPage />} />
            </Routes>
            <QuitGuard />
            <NoticeList />
        </HashRouter>
    );
}
