import _ from 'lodash';
import React from 'react';
import { PropTypes } from 'prop-types';
import { DropTarget } from 'react-dnd';

import { ALWAYS_SYNC_FOLDERS } from 'constants.js';

import EmailColumnHeader from 'components/emails/EmailColumnHeader.jsx';
import EmailColumnThread from 'components/emails/EmailColumnThread.jsx';

import filterStore from 'stores/filters.js';
import settingsStore from 'stores/settings.js';
import { getEmailStore } from 'stores/emailStoreProxy.js';
import { subscribe } from 'stores/base.jsx';
import { getColumnStore, getColumnMetaStore } from 'stores/columns.js';


const columnTarget = {
    canDrop(props, monitor) {
        const { oldColumn } = monitor.getItem();
        return oldColumn !== props.id;
    },

    drop(props, monitor) {
        const { messageUids, oldColumn, accountName } = monitor.getItem();
        const emailStore = getEmailStore();

        const accountSettings = settingsStore.getAccountSettings(accountName);
        let handler = emailStore.moveEmails;
        if (accountSettings.folders.copy_on_move === true && oldColumn == 'inbox') {
            handler = emailStore.copyEmails;
        }

        handler(
            accountName,
            messageUids,
            oldColumn,
            props.id,
        ).then(() => {
            emailStore.syncFolderEmails(
                oldColumn,
                {accountName: accountName},
            );
            emailStore.syncFolderEmails(
                props.id,
                {
                    accountName: accountName,
                    // Tell the backend to expect X messages (and infer if needed!)
                    query: {uid_count: messageUids.length},
                },
            );
        });
    },
};


function collect(connect, monitor) {
    return {
        connectDropTarget: connect.dropTarget(),
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
    };
}


export default class EmailColumnWrapper extends React.Component {
    static propTypes = {
        id: PropTypes.string.isRequired,
    }

    getDecoratedComponentInstance() {
        return this.wrappedEmailColumn
            .wrappedComponent
            .getDecoratedComponentInstance();
    }

    render() {
        // Connect the EmailColumn to the store by passing in the path of the
        // folder we want to listen for changes on.
        const WrappedEmailColumn = subscribe(
            getColumnStore(this.props.id),
            [filterStore, ['accountName']],
            settingsStore,
        )(EmailColumn);

        return <WrappedEmailColumn
            {...this.props}
            {...this.state}
            // Make the original component accessible
            ref={ref => this.wrappedEmailColumn = ref}
        />;
    }
}


@DropTarget('email', columnTarget, collect)
class EmailColumn extends React.Component {
    static propTypes = {
        id: PropTypes.string.isRequired,
        threads: PropTypes.array,
        hiddenThreadHashes: PropTypes.object.isRequired,
        accountName: PropTypes.string,
        isMainColumn: PropTypes.bool.isRequired,
        systemSettings: PropTypes.object.isRequired,
        columns: PropTypes.array.isRequired,

        isOver: PropTypes.bool.isRequired,
        canDrop: PropTypes.bool.isRequired,
        connectDropTarget: PropTypes.func.isRequired,

        // Surrounding columns
        getPreviousColumn: PropTypes.func.isRequired,
        getNextColumn: PropTypes.func.isRequired,
    }

    constructor(props) {
        super(props);

        // Disable sync if this folder is in one of the always sync folders
        this.shouldNotSync = _.includes(ALWAYS_SYNC_FOLDERS, props.id);
    }

    componentDidMount() {
        // Main column doesn't need to update itself
        if (this.shouldNotSync) {
            return;
        }

        // If no threads, we've no state for this
        if (!this.props.threads) {
            const { initial_batches, batch_size } = this.props.systemSettings;

            getEmailStore().getFolderEmails(
                this.props.id,
                {query: {
                    reset: true,
                    batch_size: batch_size * initial_batches,
                }},
            // Once initially loaded - immediately sync any changes - initial load
            // could be completely cached.
            ).then(this.getNewEmails);

        // We have threads, so immeditely check for new emails
        } else {
            this.getNewEmails();
        }

        // Kick off new email checking at the interval
        this.newEmailCheck = setInterval(
            this.getNewEmails,
            this.props.systemSettings.sync_interval,
        );
    }

    componentWillUnmount() {
        if (this.shouldNotSync) {
            return;
        }

        // Remove any pending email check
        clearInterval(this.newEmailCheck);
    }

    componentDidUpdate(prevProps) {
        if (this.props.canDrop && !prevProps.isOver && this.props.isOver) {
            this.containerDiv.classList.add('hover');
        } else {
            this.containerDiv.classList.remove('hover');
        }
    }

    getNewEmails = () => {
        // Check if we're already syncing - note we don't subscribe the whole
        // column to the meta store to avoid unnecessary renders.
        const columnMetaStore = getColumnMetaStore(this.props.id);
        if (columnMetaStore.props.isSyncing) {
            console.debug(`Not syncing ${this.props.id} as we are already syncing!`);
            return;
        }

        getEmailStore().syncFolderEmails(this.props.id);
    }

    getColumnContainer = () => {
        return this.containerDiv;
    }

    renderEmailThreads(threads) {
        if (!threads) {
            return <div className="loader">
                <i className="fa fa-spin fa-refresh"></i>
            </div>;
        }

        if (threads.length === 0) {
            return <div className="loader">
                This folder is empty
            </div>;
        }

        // Build a list of our threads and references to each, such that each
        // thread can access the previous/next threads (keyboard shortcuts).
        const threadRefs = [];

        const getThread = (id) => {
            const thread = threadRefs[id];

            if (thread) {
                // Thread is a wrapped by react-dnd, so get the underlying
                // EmailColumnThread instance!
                return thread.getDecoratedComponentInstance();
            }
        }

        const threadElements = _.map(threads, (thread, i) => {
            const getPreviousThread = () => getThread(i - 1);
            const getNextThread = () => getThread(i + 1);

            const isLastThread = i+1 == threads.length;

            return <EmailColumnThread
                key={thread.hash}
                thread={thread}
                threadRef={i}
                columnId={this.props.id}
                isLastThread={isLastThread}

                // Surrounding columns
                getColumnContainer={this.getColumnContainer}
                getPreviousColumn={this.props.getPreviousColumn}
                getNextColumn={this.props.getNextColumn}

                // Surrounding threads
                getPreviousThread={getPreviousThread}
                getNextThread={getNextThread}
                ref={ref => threadRefs[i] = ref}
            />;
        });

        // Attach the refs to the column instance for keyboard controls
        this.threadRefs = threadRefs;

        return threadElements;
    }

    getFilteredEmailThreads() {
        if (!this.props.threads) {
            return this.props.threads;
        }

        return _.filter(
            this.props.threads,
            thread => {
                const accountKey = thread[0].account_name;

                // If this thread isn't in the selected account, ignore
                if (
                    this.props.accountName
                    && accountKey !== this.props.accountName
                ) {
                    return false;
                }

                // If we're the main column and this thread is being shown in
                // another column, ignore.
                if (this.props.isMainColumn && _.some(
                    thread.allFolderNames,
                    folderName => (
                        _.includes(this.props.columns, folderName)
                    ),
                )) {
                    return false;
                }

                // If this email has been hidden (ie, is/will be moving elsewhere)
                if (getColumnStore(this.props.id).hasHiddenThread(thread)) {
                    return false;
                }

                return true;
            }
        );
    }

    handleScroll = () => {
        if (!this.emailsContainer) {
            return;
        }

        const columnMetaStore = getColumnMetaStore(this.props.id);
        if (columnMetaStore.props.isLoading) {
            console.debug(`Not loading more ${this.props.id} as we are already loading!`);
            return;
        }

        const { scrollTop, scrollHeight, clientHeight } = this.emailsContainer;

        if (scrollTop + clientHeight >= scrollHeight) {
            getEmailStore().getFolderEmails(
                this.props.id,
                {query: {
                    batch_size: this.props.systemSettings.batch_size,
                }},
            );
        }
    }

    render() {
        const { connectDropTarget } = this.props;
        const threads = this.getFilteredEmailThreads();

        return connectDropTarget(
            <div
                className="column"
                ref={(div) => {this.containerDiv = div;}}
            >
                <EmailColumnHeader
                    id={this.props.id}
                    isMainColumn={this.props.isMainColumn}
                    getNewEmails={this.getNewEmails}
                />

                <div
                    className="emails"
                    onScroll={_.throttle(this.handleScroll, 1000)}
                    ref={ref => this.emailsContainer = ref}
                >
                    {this.renderEmailThreads(threads)}
                </div>
            </div>
        );
    }
}
