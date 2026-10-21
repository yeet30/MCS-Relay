import './title-bar.css';
import logoUrl from '../../assets/logo.svg';

/** The window's title bar, drawn by the page in the theme's colour; Windows draws the minimise and close buttons
 *  over its right end. Dragging anywhere on it moves the window. */
export default function TitleBar() {
    return (
        <header className='title-bar'>
            <img src={logoUrl} alt='' width={16} height={16} />
            <span>MCS-Relay</span>
        </header>
    );
}
