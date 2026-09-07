const SUPPORTED_LANGS=["en","sn","nd","zu","xh","af","st","tn","ny","pt","sw","am","rw","lg","so","ha","yo","ig","tw","wo","fr","ar","ber","ln","kg"];
let currentLang=localStorage.getItem('chigalex_lang')||'en';
let translations={};

async function loadLanguage(lang){
 if(!SUPPORTED_LANGS.includes(lang))lang='en';
 try{
   const res=await fetch(`https://chigalex1-backend.onrender.com/api/translations/${lang}`);
   if(!res.ok) throw new Error('not ok');
   translations=await res.json();
   currentLang=lang;
   localStorage.setItem('chigalex_lang',lang);
   applyTranslations();
   // Update dropdown label
   const sel=document.getElementById('lang-select');
   if(sel) sel.value=lang;
 }
 catch(e){
   console.error('Translation load failed', e);
   if(lang!=='en')loadLanguage('en');
 }
}

function applyTranslations(){
  document.querySelectorAll('[data-i18n]').forEach(el=>{
    const k=el.getAttribute('data-i18n');
    if(translations[k]) el.innerText=translations[k];
  });
}

function setLanguage(lang){ loadLanguage(lang); }

document.addEventListener('DOMContentLoaded',()=>loadLanguage(currentLang));