import {useState} from 'react';
import {useKeyboard} from '@opentui/react';
import {repoPickerStep, repoPickerWindow} from '../repo-picker.ts';
import {dimText, terminalColor, textAttributes} from '../tui-style.ts';
import TitledBox from './TitledBox.tsx';

type Props = {
	repos: ReadonlyArray<{name: string; tag?: string}>;
	/** The row the list opens on. */
	initialIndex: number;
	/** Rows available to the dialog. */
	availableHeight?: number;
	onPick: (name: string) => void;
	onCancel: () => void;
};

/** Rows the frame, its padding and the hint take around the list. */
const CHROME_ROWS = 6;

/**
 * Which repo a new space is made in, asked on a rail that shows a whole work
 * dir. A list in the style of the profile picker: move, Enter.
 */
export default function RepoPicker({
	repos,
	initialIndex,
	availableHeight,
	onPick,
	onCancel,
}: Props) {
	const [index, setIndex] = useState(
		Math.max(0, Math.min(initialIndex, repos.length - 1)),
	);

	useKeyboard(event => {
		const step = repoPickerStep(event, index, repos.length);
		switch (step.kind) {
			case 'move': {
				setIndex(step.index);
				break;
			}

			case 'pick': {
				const picked = repos[step.index];
				if (picked) onPick(picked.name);
				break;
			}

			case 'cancel': {
				onCancel();
				break;
			}

			case 'ignore': {
				break;
			}
		}
	});

	const {start, end} = repoPickerWindow(
		repos.length,
		index,
		availableHeight === undefined
			? repos.length
			: availableHeight - CHROME_ROWS,
	);
	return (
		<TitledBox
			title="+ New Session in"
			borderColor="green"
			titleColor="greenBright"
		>
			<box flexDirection="column">
				{repos.slice(start, end).map((repo, offset) => {
					const row = start + offset;
					const isSelected = row === index;
					return (
						<text
							key={repo.name}
							wrapMode="none"
							height={1}
							fg={isSelected ? terminalColor('cyan') : undefined}
							attributes={textAttributes({bold: isSelected})}
						>
							{`${isSelected ? '❯' : ' '} ${row < 9 ? row + 1 : ' '} ${repo.name}`}
						</text>
					);
				})}
			</box>
			<box marginTop={1}>
				<text {...dimText()} wrapMode="none" height={1}>
					j/k move · Enter or 1-9 pick · Esc cancel
				</text>
			</box>
		</TitledBox>
	);
}
