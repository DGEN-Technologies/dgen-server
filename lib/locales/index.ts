import fs from "fs";
export default "ar,bn,de,el,en,es,fa,fr,hi,it,ja,ko,nl,pl,pt,ru,th,tr,zh".split(",").reduce((a: any, l: string) => {
      a[l] = JSON.parse(fs.readFileSync(`lib/locales/${l}.json`, 'utf8'));
    return a;
}, {});
