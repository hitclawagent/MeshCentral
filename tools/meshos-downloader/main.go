// meshos-downloader — airgap OS-update downloader (COMPILED) for the
// MeshCentral pkgmanager plugin (v1.9.0).
//
// The scan inventory is EMBEDDED in this binary by the MeshCentral server at
// export time (the inventory-slot.bin placeholder is patched in-place, byte
// for byte, exactly like MeshCentral patches the meshagent .msh config): run
// it on ANY machine with internet — zero arguments, zero config.
//
//     ./meshos-downloader              # all missing updates
//     ./meshos-downloader --max 3      # cap for a test run
//
// Ubuntu/Debian solid path: downloads the vendor security+updates indexes,
// computes the per-machine delta (installed != available) + the dependency
// closure, downloads ONLY the missing .deb files into os-updates/ and writes
// os-updates/manifest.json with the sha384 of every file (same manifest
// format the plugin's «Importa manifest…» consumes).
//
// Windows/macOS machines in the inventory are reported as skipped (best
// effort: missing KBs / combo updates are not deducible from an
// installed-packages scan).
package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha512"
	_ "embed" // go:embed slot
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	markerStart = "__MESHOS_INVENTORY_START__"
	markerEnd   = "__MESHOS_INVENTORY_END__"
	outDirName  = "os-updates"
	uaString    = "MeshCentral-pkgmanager/1.9.0 (meshos-downloader)"
	slotData    = 2097152 // 2MB inventory slot
	slotTotal   = len(markerStart) + slotData + len(markerEnd)
)

// The patched-in inventory lives here (server patches these very bytes).
//
//go:embed inventory-slot.bin
var slotRaw []byte

type osInfoJSON struct {
	Name     string `json:"name"`
	Version  string `json:"version"`
	Codename string `json:"codename"`
}

type machineJSON struct {
	ID    string     `json:"id"`
	Name  string     `json:"name"`
	OS    string     `json:"os"`
	Info  osInfoJSON `json:"osInfo"`
	Items []string   `json:"items"`
}

func logf(format string, args ...interface{}) {
	fmt.Println("[meshos-downloader] "+fmt.Sprintf(format, args...))
}

func loadInventory() ([]machineJSON, error) {
	if len(slotRaw) != slotTotal {
		return nil, fmt.Errorf("slot incorporato di dimensione errata (%d byte, attesi %d) — binario corrotto", len(slotRaw), slotTotal)
	}
	if !bytes.HasPrefix(slotRaw, []byte(markerStart)) || !bytes.HasSuffix(slotRaw, []byte(markerEnd)) {
		return nil, fmt.Errorf("marcatori dello slot non trovati — binario corrotto")
	}
	data := bytes.TrimRight(slotRaw[len(markerStart):len(slotRaw)-len(markerEnd)], "\x00")
	if len(data) == 0 {
		return nil, fmt.Errorf("inventario NON incorporato: esporta il downloader dalla vista Aggiornamenti OS del plugin (Scansiona macchine -> Esporta downloader...)")
	}
	var inv []machineJSON
	if err := json.Unmarshal(data, &inv); err != nil {
		return nil, fmt.Errorf("inventario incorporato non leggibile: %v", err)
	}
	return inv, nil
}

var httpClient = &http.Client{Timeout: 90 * time.Second}

func httpGet(url string) ([]byte, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", uaString)
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d %s", resp.StatusCode, url)
	}
	return io.ReadAll(resp.Body)
}

func httpGetAny(urls ...string) ([]byte, string) {
	for _, u := range urls {
		if b, err := httpGet(u); err == nil {
			return b, u
		}
	}
	return nil, ""
}

func sha384of(b []byte) string {
	h := sha512.Sum384(b)
	return hex.EncodeToString(h[:])
}

var hasDpkg = func() bool {
	_, err := exec.LookPath("dpkg")
	return err == nil
}()

func verGe(a, b string) bool {
	if a == b {
		return true
	}
	if hasDpkg {
		c := exec.Command("dpkg", "--compare-versions", a, "ge", b)
		c.Stdout = nil
		c.Stderr = nil
		if err := c.Run(); err == nil {
			return true
		}
		return false
	}
	return a >= b
}

type stanza = map[string]string

func parseIndex(text string) map[string][]stanza {
	idx := map[string][]stanza{}
	cur := stanza{}
	flush := func() {
		if cur["Package"] != "" && cur["Version"] != "" && cur["Filename"] != "" {
			if cur["Architecture"] == "amd64" || cur["Architecture"] == "all" {
				idx[cur["Package"]] = append(idx[cur["Package"]], cur)
			}
		}
	}
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == "" {
			flush()
			cur = stanza{}
			continue
		}
		p := strings.Index(line, ":")
		if p > 0 {
			k := strings.TrimSpace(line[:p])
			v := strings.TrimSpace(line[p+1:])
			if _, ok := cur[k]; !ok {
				cur[k] = v
			}
		}
	}
	flush()
	return idx
}

func best(stanzas []stanza) stanza {
	out := stanzas[0]
	for _, s := range stanzas {
		if verGe(s["Version"], out["Version"]) {
			out = s
		}
	}
	return out
}

func depGroups(dep string) [][]string {
	out := [][]string{}
	for _, grp := range strings.Split(dep, ",") {
		grp = strings.TrimSpace(grp)
		if grp == "" {
			continue
		}
		names := []string{}
		for _, alt := range strings.Split(grp, "|") {
			nm := strings.TrimSpace(strings.Split(alt, "(")[0])
			if nm != "" {
				names = append(names, nm)
			}
		}
		if len(names) > 0 {
			out = append(out, names)
		}
	}
	return out
}

type skipEntry struct {
	Machine string `json:"machine,omitempty"`
	File    string `json:"file,omitempty"`
	Reason  string `json:"reason"`
}

type fileEntry struct {
	OS      string   `json:"os"`
	Package string   `json:"package"`
	Version string   `json:"version"`
	File    string   `json:"file"`
	SHA384  string   `json:"sha384"`
	Size    int      `json:"size"`
	Targets []string `json:"targets"`
}

func main() {
	maxFiles := 0
	for i := 1; i < len(os.Args); i++ {
		if os.Args[i] == "--max" && i+1 < len(os.Args) {
			if v, err := strconv.Atoi(os.Args[i+1]); err == nil {
				maxFiles = v
			} else {
				logf("avviso: --max non numerico, ignorato")
			}
			i++
		}
	}
	inv, err := loadInventory()
	if err != nil {
		fmt.Println("ERRORE: " + err.Error())
		os.Exit(1)
	}
	if err := os.MkdirAll(outDirName, 0o755); err != nil {
		fmt.Println("ERRORE: impossibile creare " + outDirName + ": " + err.Error())
		os.Exit(1)
	}
	files := []fileEntry{}
	skips := []skipEntry{}
	idxCache := map[string]map[string][]stanza{}
	type doneEnt struct {
		pkg, ver, file, orig, alt string
		size                      int
		targets                   map[string]bool
	}
	done := map[string]*doneEnt{}

	for _, m := range inv {
		osName := strings.ToLower(m.OS)
		if osName == "windows" || osName == "macos" || osName == "darwin" {
			skips = append(skips, skipEntry{Machine: m.Name, Reason: osName + ": best effort — KB/combo non deducibili dalla sola scansione (usa meshos-fetch --kb/--macos o WSUS)"})
			continue
		}
		codename := strings.TrimSpace(m.Info.Codename)
		if codename == "" {
			skips = append(skips, skipEntry{Machine: m.Name, Reason: "codename assente nell'inventario (scansione vecchia?)"})
			continue
		}
		installed := map[string]string{}
		for _, it := range m.Items {
			s := string(it)
			p := strings.Index(s, " ")
			if p > 0 {
				installed[s[:p]] = strings.TrimSpace(s[p+1:])
			}
		}
		logf("linux %s: %d pacchetti installati (Ubuntu %s)", m.Name, len(installed), codename)
		idx, ok := idxCache[codename]
		if !ok {
			idx = map[string][]stanza{}
			pockets := []string{
				"https://security.ubuntu.com/ubuntu/dists/" + codename + "-security",
				"https://archive.ubuntu.com/ubuntu/dists/" + codename + "-updates",
			}
			for _, pocket := range pockets {
				for _, area := range []string{"main", "universe"} {
					url := pocket + "/" + area + "/binary-amd64/Packages.gz"
					var text string
					if b, _ := httpGetAny(url, strings.Replace(url, "https://", "http://", 1)); b != nil {
						if gz, err := gzip.NewReader(bytes.NewReader(b)); err == nil {
							if raw, err2 := io.ReadAll(gz); err2 == nil {
								text = string(raw)
							}
						}
					}
					if text == "" {
						skips = append(skips, skipEntry{Machine: "(indice)", Reason: "indice vendor non raggiungibile: " + url})
						continue
					}
					for name, stz := range parseIndex(text) {
						idx[name] = append(idx[name], stz...)
					}
				}
			}
			idxCache[codename] = idx
		}
		type qi struct {
			name   string
			st     stanza
		}
		queue := []qi{}
		queued := map[string]bool{}
		push := func(name, reason string) {
			stz, okq := idx[name]
			if !okq || len(stz) == 0 {
				return
			}
			cand := best(stz)
			key := name + "_" + cand["Version"]
			if queued[key] {
				return
			}
			queued[key] = true
			queue = append(queue, qi{name: name, st: cand})
		}
		for iname := range installed {
			stz, okq := idx[iname]
			if !okq || len(stz) == 0 {
				continue
			}
			cand := best(stz)
			if !verGe(installed[iname], cand["Version"]) {
				push(iname, "aggiornamento disponibile")
			}
		}
		seen := map[string]bool{}
		for k := range queued {
			seen[k] = true
		}
		frontier := make([]qi, len(queue))
		copy(frontier, queue)
		for len(frontier) > 0 {
			next := []qi{}
			for _, cur := range frontier {
				deps := depGroups(cur.st["Depends"] + "," + cur.st["Pre-Depends"])
				for _, alts := range deps {
					pick := ""
					for _, nm := range alts {
						if _, okn := idx[nm]; okn {
							pick = nm
							break
						}
					}
					if pick == "" {
						continue
					}
					if _, okn := installed[pick]; okn {
						continue
					}
					if seen[pick] {
						continue
					}
					seen[pick] = true
					stz := best(idx[pick])
					key := pick + "_" + stz["Version"]
					if queued[key] {
						continue
					}
					queued[key] = true
					item := qi{name: pick, st: stz}
					queue = append(queue, item)
					next = append(next, item)
				}
			}
			frontier = next
		}
		logf("  delta+dipendenze: %d pacchetti", len(queue))
		for _, q := range queue {
			key := q.name + "_" + q.st["Version"]
			if _, okd := done[key]; !okd {
				done[key] = &doneEnt{
					pkg: q.name, ver: q.st["Version"],
					file: q.name + "_" + q.st["Version"] + "_" + pickArch(q.st) + ".deb",
					orig: "http://archive.ubuntu.com/ubuntu/" + q.st["Filename"],
					alt:  "http://security.ubuntu.com/ubuntu/" + q.st["Filename"],
					size: parseIntSafe(q.st["Size"]),
					targets: map[string]bool{},
				}
			}
			done[key].targets[m.ID] = true
		}
	}

	order := make([]*doneEnt, 0, len(done))
	for _, e := range done {
		order = append(order, e)
	}
	sort.Slice(order, func(i, j int) bool { return order[i].size < order[j].size })
	capNote := ""
	if maxFiles > 0 {
		capNote = fmt.Sprintf(" (cap --max %d)", maxFiles)
	}
	logf("download unificato: %d file distinti%s", len(order), capNote)
	for _, e := range order {
		if maxFiles > 0 && len(files) >= maxFiles {
			skips = append(skips, skipEntry{File: e.file, Reason: fmt.Sprintf("cap --max raggiunto (per il resto rilancialo senza --max) (%d)", maxFiles)})
			continue
		}
		buf, _ := httpGetAny(e.orig, e.alt)
		if buf == nil {
			skips = append(skips, skipEntry{File: e.file, Reason: "download fallito (" + e.orig + ")"})
			continue
		}
		if err := os.WriteFile(outDirName+"/"+e.file, buf, 0o644); err != nil {
			skips = append(skips, skipEntry{File: e.file, Reason: "scrittura fallita: " + err.Error()})
			continue
		}
		tg := make([]string, 0, len(e.targets))
		for t := range e.targets {
			tg = append(tg, t)
		}
		sort.Strings(tg)
		files = append(files, fileEntry{OS: "linux", Package: e.pkg, Version: e.ver, File: e.file, SHA384: sha384of(buf), Size: len(buf), Targets: tg})
		logf("  ok %s (%dKB)", e.file, len(buf)/1024)
	}

	manifest := map[string]interface{}{
		"tool":     "pkgmanager-export",
		"version":  "1.9",
		"generated": time.Now().UTC().Format(time.RFC3339),
		"files":    files,
		"skipped":  skips,
	}
	mb, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		fmt.Println("ERRORE manifest: " + err.Error())
		os.Exit(1)
	}
	if err := os.WriteFile(outDirName+"/manifest.json", mb, 0o644); err != nil {
		fmt.Println("ERRORE scrittura manifest: " + err.Error())
		os.Exit(1)
	}
	logf("fatto: %d file scaricati, %d saltati -> %s", len(files), len(skips), outDirName)
	logf("prossimo passo: copia %s/ nello store del server (My Files -> Pacchetti (pkgmanager) -> store/<id-bundle>/) e «Importa manifest…» nel plugin.", outDirName)
}

func pickArch(s stanza) string {
	if s["Architecture"] != "" {
		return s["Architecture"]
	}
	return "amd64"
}

func parseIntSafe(v string) int {
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		return 0
	}
	return n
}