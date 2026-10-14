import { mount } from 'svelte';
import Setup from './Setup.svelte';
import '../ui/theme/app.css';

mount(Setup, { target: document.getElementById('app')! });
