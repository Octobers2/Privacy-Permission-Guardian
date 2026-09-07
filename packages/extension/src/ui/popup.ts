import { mount } from 'svelte';
import Popup from './Popup.svelte';
import './theme/app.css';

mount(Popup, { target: document.getElementById('app')! });
