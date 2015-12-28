/**
 * Copyright (C) 2015 Laverna project Authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */
/* global define */
define([
    'underscore',
    'marionette',
    'backbone.radio',
    'codemirror/lib/codemirror',
    'modules/codemirror/views/editor',
    'codemirror/mode/gfm/gfm',
    'codemirror/mode/markdown/markdown',
    'codemirror/addon/edit/continuelist',
    'codemirror/addon/mode/overlay',
], function(_, Marionette, Radio, CodeMirror, View) {
    'use strict';

    /**
     * Codemirror module.
     * Regex and WYSIWG button functions are based on simplemde-markdown-editor:
     * https://github.com/NextStepWebs/simplemde-markdown-editor
     */
    var Controller = Marionette.Object.extend({

        marks: {
            strong: {
                tag   : ['**', '__'],
                start : /(\*\*|__)(?![\s\S]*(\*\*|__))/,
                end   : /(\*\*|__)/,
            },
            em: {
                tag   : ['*', '_'],
                start : /(\*|_)(?![\s\S]*(\*|_))/,
                end   : /(\*|_)/,
            },
            strikethrough: {
                tag   : ['~~'],
                start : /(\*\*|~~)(?![\s\S]*(\*\*|~~))/,
                end   : /(\*\*|~~)/,
            },
            'code': {
                tag    : '```\r\n',
                tagEnd : '\r\n```',
            },
            'unordered-list': {
                replace : /^(\s*)(\*|\-|\+)\s+/,
                tag     : '* ',
            },
            'ordered-list': {
                replace : /^(\s*)\d+\.\s+/,
                tag     : '1. ',
            },
        },

        initialize: function() {
            _.bindAll(this, 'onChange', 'onScroll', 'onCursor', 'boldAction', 'italicAction', 'linkAction', 'headingAction', 'attachmentAction', 'codeAction', 'hrAction', 'listAction', 'numberedListAction');

            // Get configs
            this.configs = Radio.request('configs', 'get:object');

            // Initialize the view
            this.view = new View({
                model   : Radio.request('notesForm', 'model'),
                configs : this.configs
            });

            this.view.once('dom:refresh', this.initEditor, this);

            // Events
            this.listenTo(this.view, 'editor:action', this.onViewAction);
            this.listenTo(Radio.channel('notesForm'), 'set:mode', this.changeMode);

            // Show the view and render Pagedown editor
            Radio.request('notesForm', 'show:editor', this.view);

            Radio.reply('editor', {
                'get:data'      : this.getData,
                'generate:link' : this.generateLink,
                'generate:image': this.generateImage
            }, this);
        },

        onDestroy: function() {
            Radio.stopReplying('editor', 'get:data');
        },

        initEditor: function() {
            this.editor = CodeMirror.fromTextArea(document.getElementById('editor--input'), {
                mode          : {
                    name        : 'gfm',
                    gitHubSpice : false
                },
                lineNumbers   : false,
                matchBrackets : true,
                lineWrapping  : true,
                extraKeys     : {
                    'Cmd-B'  : this.boldAction,
                    'Ctrl-B' : this.boldAction,

                    'Cmd-I'  : this.italicAction,
                    'Ctrl-I' : this.italicAction,

                    'Cmd-H'  : this.headingAction,
                    'Ctrl-H' : this.headingAction,

                    'Cmd-L'  : this.linkAction,
                    'Ctrl-L' : this.linkAction,

                    'Cmd-K'  : this.codeAction,
                    'Ctrl-K' : this.codeAction,

                    'Cmd-O'  : this.numberedListAction,
                    'Ctrl-O' : this.numberedListAction,

                    'Cmd-U'  : this.listAction,
                    'Ctrl-U' : this.listAction,

                    // Ctrl+d - divider
                    'Cmd-G'  : this.attachmentAction,
                    'Ctrl-G' : this.attachmentAction,

                    // Ctrl+d - divider
                    'Cmd-D'  : this.hrAction,
                    'Ctrl-D' : this.hrAction,

                    'Enter': 'newlineAndIndentContinueMarkdownList'
                }
            });

            window.dispatchEvent(new Event('resize'));
            this.editor.on('change', this.onChange);
            this.editor.on('scroll', this.onScroll);
            this.editor.on('cursorActivity', this.onCursor);

            // Show the preview
            this.updatePreview();
        },

        changeMode: function() {
            window.dispatchEvent(new Event('resize'));
        },

        /**
         * Update the preview.
         */
        updatePreview: function() {
            var self = this;

            return Radio.request('markdown', 'render', this.editor.getValue())
            .then(function(content) {
                self.view.trigger('editor:change', content);
            });
        },

        /**
         * Text in the editor changed.
         */
        onChange: function() {

            // Update the preview
            this.updatePreview();

            // Trigger autosave
            this.autoSave();
        },

        /**
         * Editor's cursor position changed.
         */
        onCursor: function() {
            var state  = this.getState();
            this.$btns = this.$btns || $('.editor--btns .btn');

            // Make a specific button active depending on the type of the element under cursor
            this.$btns.removeClass('btn-primary');
            for (var i = 0; i < state.length; i++) {
                this['$btn' + state[i]] = this['$btn' + state[i]] || $('.editor--btns [data-state="' + state[i] + '"]');
                this['$btn' + state[i]].addClass('btn-primary');
            }
        },

        /**
         * Trigger 'save:auto' event.
         */
        autoSave: _.debounce(function() {
            Radio.trigger('notesForm', 'save:auto');
        }, 1000),

        /**
         * Synchronize the editor's scroll position with the preview's.
         */
        onScroll: _.debounce(function(e) {

            // Don't do any computations
            if (!e.doc.scrollTop) {
                this.view.ui.preview.scrollTop(0);
                return;
            }

            var info       = this.editor.getScrollInfo(),
                lineNumber = this.editor.lineAtHeight(info.top, 'local'),
                range      = this.editor.getRange({line: 0, ch: null}, {line: lineNumber, ch: null}),
                self       = this,
                fragment,
                temp,
                lines,
                els;

            Radio.request('markdown', 'render', range)
            .then(function(html) {

                // Create a fragment and attach rendered HTML
                fragment       = document.createDocumentFragment();
                temp           = document.createElement('div');
                temp.innerHTML = html;
                fragment.appendChild(temp);

                // Get all elements in both the fragment and the preview
                lines = temp.children;
                els   = self.view.ui.preview[0].children;

                // Get from the preview the last visible element of the editor
                var newPos = els[lines.length].offsetTop;

                /**
                 * If the scroll position is on the same element,
                 * change it according to the difference of scroll positions in the editor.
                 */
                if (self.scrollTop && self.scrollPos === newPos) {
                    self.view.ui.preview.scrollTop(self.view.ui.preview.scrollTop() + (e.doc.scrollTop - self.scrollTop));
                    self.scrollTop = e.doc.scrollTop;
                    return;
                }

                // Scroll to the last visible element's position
                self.view.ui.preview.animate({
                    scrollTop: newPos
                }, 70, 'swing');

                self.scrollPos = newPos;
                self.scrollTop = e.doc.scrollTop;
            });
        }, 10),

        /**
         * If the view triggered some action event, call a suitable function.
         * For instance, when action='bold', call boldAction method.
         */
        onViewAction: function(action) {
            action = action + 'Action';

            if (this[action]) {
                this[action]();
            }
        },

        /**
         * Return data from the editor.
         */
        getData: function() {
            var content = this.editor.getValue();

            return Radio.request('markdown', 'parse', content)
            .then(function(env) {
                return {
                    content: content,
                    tags: env.tags || [],
                    tasks: []
                };
            });
        },

        /**
         * Return state of the element under the cursor.
         */
        getState: function(pos) {
            pos      = pos || this.editor.getCursor('start');
            var stat = this.editor.getTokenAt(pos);

            if (!stat.type) {
                return [];
            }

            stat.type = stat.type.split(' ');

            if (_.indexOf(stat.type, 'variable-2') !== -1) {
                if (/^\s*\d+\.\s/.test(this.editor.getLine(pos.line))) {
                    stat.type.push('ordered-list');
                }
                else {
                    stat.type.push('unordered-list');
                }
            }


            return stat.type;
        },

        /**
         * Toggle Markdown block.
         */
        toggleBlock: function(type) {
            var stat  = this.getState(),
                start = this.editor.getCursor('start'),
                end   = this.editor.getCursor('end'),
		        text,
		        startText,
		        endText;

            // Text is already [strong|italic|etc]
            if (_.indexOf(stat, type) !== -1) {
                text      = this.editor.getLine(start.line);
                startText = text.slice(0, start.ch);
                endText   = text.slice(start.ch);

                // Remove Markdown tags from the text
                startText = startText.replace(this.marks[type].start, '');
                endText   = endText.replace(this.marks[type].end, '');

                this.replaceRange(startText + endText, start.line);

                start.ch -= this.marks[type].tag[0].length;
                end.ch   -= this.marks[type].tag[0].length;
            }
            else {
                text = this.editor.getSelection();

			    for (var i = 0; i < this.marks[type].tag.length - 1; i++) {
                    text = text.split(this.marks[type].tag[i]).join('');
			    }

		        this.editor.replaceSelection(this.marks[type].tag[0] + text + this.marks[type].tag[0]);

                start.ch += this.marks[type].tag[0].length;
                end.ch    = start.ch + text.length;
            }

            this.editor.setSelection(start, end);
            this.editor.focus();
        },

        /**
         * Make selected text strong.
         */
        boldAction: function() {
            this.toggleBlock('strong');
        },

        /**
         * Make selected text italicized.
         */
        italicAction: function() {
            this.toggleBlock('em');
        },

        /**
         * Create headings.
         */
        headingAction: function() {
            var start = this.editor.getCursor('start'),
                end   = this.editor.getCursor('end');

            for (var i = start.line; i <= end.line; i++) {
                this.toggleHeading(i);
            }
        },

        /**
         * Show a dialog to attach images or files.
         */
        attachmentAction: function() {
            var self   = this,
                dialog = Radio.request('editor', 'show:attachment', this.view.model);

            if (!dialog) {
                return;
            }

            dialog.then(function(text) {
                if (!text || !text.length) {
                    return;
                }

                self.editor.replaceSelection(text, true);
                self.editor.focus();
            });
        },

        /**
         * Show a link dialog.
         */
        linkAction: function() {
            var self   = this,
                dialog = Radio.request('editor', 'show:link');

            if (!dialog) {
                return;
            }

            dialog.then(function(link) {
                if (!link || !link.length) {
                    return;
                }

                var cursor = self.editor.getCursor('start'),
                    text   = self.editor.getSelection() || 'Link';

                self.editor.replaceSelection('[' + text + '](' + link + ')');
                self.editor.setSelection(
                    {line: cursor.line, ch: cursor.ch + 1},
                    {line: cursor.line, ch: cursor.ch + text.length + 1}
                );
                self.editor.focus();
            });
        },

        /**
         * Create a divider.
         */
        hrAction: function() {
            var start = this.editor.getCursor('start');
            this.editor.replaceSelection('\r\r-----\r\r');

            start.line += 4;
            start.ch    = 0;
            this.editor.setSelection( start, start );
            this.editor.focus();
        },

        /**
         * Create a code block.
         */
        codeAction: function() {
            var state = this.getState(),
                start = this.editor.getCursor('start'),
                end   = this.editor.getCursor('end'),
                text;

            if (_.indexOf(state, 'code') !== -1) {
                return;
            }
            else {
                text = this.editor.getSelection();
                this.editor.replaceSelection(this.marks.code.tag + text + this.marks.code.tagEnd);
            }
            this.editor.setSelection({line: start.line + 1, ch: start.ch}, {line: end.line + 1, ch: end.ch});
            this.editor.focus();
        },

        replaceRange: function(text, line) {
            this.editor.replaceRange(text, {
                line : line,
                ch   : 0
            }, {
                line : line,
                ch   : 99999999999999
            });
            this.editor.focus();
        },

        /**
         * Convert a line to a headline.
         */
        toggleHeading: function(i) {
            var text       = this.editor.getLine(i),
			    headingLvl = text.search(/[^#]/);

            // Create a default headline
            if (headingLvl === -1) {
                text = '# Heading';

                this.replaceRange(text, i);
                return this.editor.setSelection(
                    {line: i, ch: 2},
                    {line: i, ch: 9}
                );
            }

            // Increase headline level up to 6th
            if (headingLvl < 6) {
                text = headingLvl > 0 ? text.substr(headingLvl + 1) : text;
                text = new Array(headingLvl + 2).join('#') + ' ' + text;
            }
            else {
                text = text.substr(headingLvl + 1);
            }

            this.replaceRange(text, i);
        },

        /**
         * Convert selected text to unordered list.
         */
        listAction: function() {
            this.toggleLists('unordered-list');
        },

        /**
         * Convert selected text to ordered list.
         */
        numberedListAction: function() {
            this.toggleLists('ordered-list', 1);
        },

        /**
         * Convert several selected lines to ordered or unordered lists.
         */
        toggleLists: function(type, order) {
            var state = this.getState(),
                start = this.editor.getCursor('start'),
                end   = this.editor.getCursor('end');

            // Convert each line to list
            _.each(new Array(end.line - start.line + 1), function(val, i) {
                this.toggleList(type, start.line + i, state, order);
                if (order) {
                    order++;
                }
            }, this);
        },

        /**
         * Convert selected text to an ordered or unordered list.
         */
        toggleList: function(name, line, state, order) {
            var text = this.editor.getLine(line);

            // If it is a list, convert it to normal text
            if (_.indexOf(state, name) !== -1) {
                text = text.replace(this.marks[name].replace, '$1');
            }
            else if (order) {
                text = order + '. ' + text;
            }
            else {
                text = this.marks[name].tag + text;
            }

            this.replaceRange(text, line);
        },

        /**
         * Redo the last action in Codemirror.
         */
        redoAction: function() {
            this.editor.redo();
        },

        /**
         * Undo the last action in Codemirror.
         */
        undoAction: function() {
            this.editor.undo();
        },

        generateLink: function(data) {
            return '[' + data.text + ']' + '(' + data.url + ')';
        },

        generateImage: function(data) {
            return '!' + this.generateLink(data);
        },

    });

    return Controller;
});
