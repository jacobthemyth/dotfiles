;;; $DOOMDIR/config.el -*- lexical-binding: t; -*-

;; Place your private configuration here! Remember, you do not need to run 'doom
;; sync' after modifying this file!


;; Some functionality uses this to identify you, e.g. GPG configuration, email
;; clients, file templates and snippets.
(setq user-full-name "Jacob Smith"
      user-mail-address "jacob@jacobsmith.io")

;; Doom exposes five (optional) variables for controlling fonts in Doom. Here
;; are the three important ones:
;;
;; + `doom-font'
;; + `doom-variable-pitch-font'
;; + `doom-big-font' -- used for `doom-big-font-mode'; use this for
;;   presentations or streaming.
;;
;; They all accept either a font-spec, font string ("Input Mono-12"), or xlfd
;; font string. You generally only need these two:
;; (setq doom-font (font-spec :family "Operator Mono SSm for Powerline" :size 16)
;;       doom-variable-pitch-font (font-spec :family "sans" :size 13))

;; There are two ways to load a theme. Both assume the theme is installed and
;; available. You can either set `doom-theme' or manually load a theme with the
;; `load-theme' function. This is the default:
(setq doom-theme 'doom-one)

;; If you use `org' and don't want your org files in the default location below,
;; change `org-directory'. It must be set before org loads!
(setq org-directory "~/Dropbox/org/")
(setq org-roam-directory "~/Dropbox/org/")

;; This determines the style of line numbers in effect. If set to `nil', line
;; numbers are disabled. For relative line numbers, set this to `relative'.
(setq display-line-numbers-type t)

(setq menu-bar-mode t)

;; Here are some additional functions/macros that could help you configure Doom:
;;
;; - `load!' for loading external *.el files relative to this one
;; - `use-package!' for configuring packages
;; - `after!' for running code after a package has loaded
;; - `add-load-path!' for adding directories to the `load-path', relative to
;;   this file. Emacs searches the `load-path' when you load packages with
;;   `require' or `use-package'.
;; - `map!' for binding new keys
;;
;; To get information about any of these functions/macros, move the cursor over
;; the highlighted symbol at press 'K' (non-evil users must press 'C-c c k').
;; This will open documentation for it, including demos of how they are used.
;;
;; You can also try 'gd' (or 'C-c c d') to jump to their definition and see how
;; they are implemented.

(setq org-capture-templates
      (quote (("t" "todo" entry (file "~/Dropbox/org/Inbox.org")
               "* TODO %?\n%a\n"))))

; (add-to-list 'org-roam-capture-templates
;     '("m" "Markdown" plain "" :target
;         (file+head "%<%Y-%m-%dT%H%M%S>.md"
; "---\ntitle: ${title}\nid: %<%Y-%m-%dT%H%M%S>\ncategory: \n---\n")
;     :unnarrowed t))

(after! 'org-roam
   ; md-roam-mode needs to be active before org-roam-db-sync
  (md-roam-mode 1))

(setq org-roam-file-extensions '("org" "md")) ; enable Org-roam for a markdown extension

(defun systemist/copy-as-rtf ()
  "Export region to RTF and copy it to the clipboard."
  (interactive)
  (save-window-excursion
    (let* ((buf (org-export-to-buffer 'html "*Formatted Copy*" nil nil t t))
           (html (with-current-buffer buf (buffer-string))))
      (with-current-buffer buf
        (shell-command-on-region
         (point-min)
         (point-max)
         "textutil -stdin -format html -convert rtf -stdout | pbcopy"))
      (kill-buffer buf))))

(add-hook 'markdown-mode-hook #'systemist/markdown-mode-hook)
(defun systemist/markdown-mode-hook ()
  "Custom `markdown-mode` behaviors."
  (critic-minor-mode))

(add-hook 'org-mode-hook #'systemist/org-mode-hook)
(defun systemist/org-mode-hook ()
  "Custom `org-mode` behaviors."
  (critic-minor-mode))

(add-hook 'dired-mode-hook 'dired-hide-details-mode)

(setq +org-roam-open-buffer-on-find-file nil)

(map! :nv "gx" #'browse-url-at-point)
